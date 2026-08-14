/**
 * OpenList 服务层
 *
 * OpenList（基于 AList）支持 WebDAV 协议访问，默认端点为 `/dav`。
 * 本模块复用 `services/webdav.ts` 的 WebDAV 客户端能力，仅提供 OpenList 专属的
 * 错误类型与挂载参数转换辅助函数，避免重复实现。
 *
 * 此外提供 `fetchOpenListDirectUrl`，通过 OpenList HTTP API（/api/auth/login + /api/fs/get）
 * 获取带签名的真实下载直链，供"直链模式"使用。
 */
import type { WebDAVConnectionParams } from './webdav';
import type { UserMount } from '../entities/UserMount';

// OpenList 错误类型：复用 WebDAV 的错误码体系（AUTH_FAILED/UNREACHABLE/NOT_FOUND/TIMEOUT）
export class OpenListError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'OpenListError';
    this.code = code;
  }
}

/**
 * 规范化 OpenList 服务器地址：
 * - 去除首尾空白
 * - 若无协议前缀，补 `http://`（OpenList 实例通常以 HTTP 暴露 WebDAV）
 * - 若 URL 仅有协议+域名（无路径或路径为 `/`），自动补 `/dav`
 *   OpenList/AList 的 WebDAV 端点默认为 `/dav`，用户在 UI 中通常只填域名，
 *   自动补全可避免"测试连接失败"的困惑。
 * - 去除末尾多余的斜杠
 */
export function normalizeOpenListServerUrl(serverUrl: string): string {
  let normalized = serverUrl.trim();
  if (!normalized) return normalized;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) {
    normalized = `http://${normalized}`;
  }
  while (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  // 解析 URL，若 path 部分为空或仅 /，自动补 /dav
  try {
    const parsed = new URL(normalized);
    if (!parsed.pathname || parsed.pathname === '/' || parsed.pathname === '') {
      normalized = `${parsed.origin}/dav`;
    }
  } catch {
    // URL 解析失败时保持原样，让后续 WebDAV 客户端报错
  }
  return normalized;
}

/**
 * 从 OpenList WebDAV 端点地址推导 API 基地址。
 * 例：`http://host/dav` → `http://host`；`http://host` → `http://host`。
 */
function deriveApiBaseUrl(serverUrl: string): string {
  const normalized = normalizeOpenListServerUrl(serverUrl);
  // 去掉末尾的 /dav
  if (normalized.endsWith('/dav')) {
    return normalized.slice(0, -4);
  }
  return normalized;
}

/**
 * 获取 OpenList 文件的真实下载直链。
 *
 * 流程：
 * 1. 使用 username + password 调用 `/api/auth/login` 获取 token
 * 2. 携带 token 调用 `/api/fs/get` 获取 `raw_url`（带签名的真实下载 URL）
 *
 * 该 URL 可直接在浏览器 `<video>` 中播放，无需再走服务器代理。
 *
 * @param serverUrl OpenList 服务器地址（含或不含 /dav 后缀均可）
 * @param username 用户名（可选，匿名访问时留空）
 * @param password 密码
 * @param path     文件在 OpenList 中的绝对路径（如 `/movie/foo.mp4`）
 * @returns 真实下载直链 URL
 */
export async function fetchOpenListDirectUrl(
  serverUrl: string,
  username: string | undefined,
  password: string | undefined,
  path: string,
): Promise<string> {
  const baseUrl = deriveApiBaseUrl(serverUrl);
  // AList 的 /api/fs/get 接口期望的是原始路径（未 URL 编码），
  // 但前端通过 URLSearchParams 传递的 path 可能是 URL 编码的。
  // 这里对 path 进行 URL 解码，得到原始路径。
  let targetPath: string;
  try {
    targetPath = decodeURIComponent(path);
  } catch {
    targetPath = path;
  }
  if (!targetPath.startsWith('/')) {
    targetPath = '/' + targetPath;
  }

  // 1. 登录获取 token（仅在提供凭证时进行）
  let token: string | undefined;
  if (username && password) {
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!loginRes.ok) {
      throw new OpenListError(
        `OpenList 登录失败: HTTP ${loginRes.status}`,
        'AUTH_FAILED',
      );
    }
    const loginData = (await loginRes.json()) as {
      code?: number;
      message?: string;
      data?: { token?: string };
    };
    if (loginData.code !== 200) {
      throw new OpenListError(
        loginData.message || 'OpenList 登录失败',
        'AUTH_FAILED',
      );
    }
    token = loginData.data?.token;
    if (!token) {
      throw new OpenListError('OpenList 未返回 token', 'AUTH_FAILED');
    }
  }

  // 2. 调用 /api/fs/get 获取 raw_url
  const fsRes = await fetch(`${baseUrl}/api/fs/get`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: token } : {}),
    },
    body: JSON.stringify({ path: targetPath, password: undefined }),
  });
  if (!fsRes.ok) {
    throw new OpenListError(
      `获取直链失败: HTTP ${fsRes.status}`,
      'UNREACHABLE',
    );
  }
  const fsData = (await fsRes.json()) as {
    code?: number;
    message?: string;
    data?: { raw_url?: string; name?: string };
  };
  if (fsData.code !== 200) {
    const code = fsData.code === 401 ? 'AUTH_FAILED' : 'NOT_FOUND';
    // AList 上游返回的英文错误消息（如 "object not found"）对用户不友好，
    // 根据 code 转换为中文提示，保留原始消息作为辅助信息。
    const upstreamMessage = fsData.message || '';
    let friendlyMessage: string;
    if (code === 'AUTH_FAILED') {
      friendlyMessage = 'OpenList 认证失败，请检查挂载的用户名和密码';
    } else {
      // NOT_FOUND：AList 返回 "object not found" 表示文件/路径不存在
      friendlyMessage = `文件不存在或路径错误: ${targetPath}`;
    }
    console.warn(
      `[openlist] /api/fs/get 失败 code=${fsData.code} path=${targetPath} upstream=${upstreamMessage}`,
    );
    throw new OpenListError(friendlyMessage, code);
  }
  const rawUrl = fsData.data?.raw_url;
  if (!rawUrl) {
    throw new OpenListError('OpenList 未返回 raw_url', 'UNREACHABLE');
  }
  // AList 未配置 site_url 时，raw_url 可能是相对路径（如 /d/path/file.mp4?sign=xxx），
  // 需要拼接 AList 服务器地址，否则浏览器会相对当前页面 origin 解析，请求到前端服务器。
  if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
    return rawUrl;
  }
  // 相对路径：拼接 AList API 基地址
  const absoluteUrl = `${baseUrl}${rawUrl.startsWith('/') ? rawUrl : '/' + rawUrl}`;
  return absoluteUrl;
}

/**
 * 将 UserMount 记录转换为 WebDAVConnectionParams。
 * OpenList 的 serverUrl 应为完整的 WebDAV 端点（如 `http://host/dav`）。
 */
export function mountToOpenListParams(mount: UserMount): WebDAVConnectionParams {
  return {
    serverUrl: normalizeOpenListServerUrl(mount.serverUrl || ''),
    path: mount.path || '/',
    username: mount.username || undefined,
    password: mount.password || undefined,
  };
}
