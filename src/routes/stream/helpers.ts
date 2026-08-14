/**
 * /api/stream 路由共享的 B站 工具函数。
 * 从原 stream.ts 抽离，供 bilibili-auth / resolve / proxy 子路由复用。
 */

import { bilibiliFetch } from '../../services/bilibili/client';
import { getCredential } from '../../services/bilibili/credential';
import { setCachedUserInfo } from '../../services/bilibili/cache';
import { DEFAULT_PROXY_UA } from '../../services/proxy';

export interface BilibiliQrGenerateResponse {
  data?: {
    url: string;
    qrcode_key: string;
  };
}

export interface BilibiliQrPollResponse {
  data?: {
    qrcode_key?: string;
    status?: number;
    code?: number;
    message?: string;
    url?: string;
    refresh_token?: string;
    timestamp?: number;
  };
}

export interface BilibiliNavData {
  isLogin?: boolean;
  mid?: number;
  uname?: string;
  face?: string;
  vipStatus?: number;
  vipType?: number;
}

/** 读取指定用户已保存的 B站 登录 Cookie */
export async function getUserCookie(
  userId: string | number | undefined,
): Promise<string | null> {
  if (userId === undefined || userId === null) return null;
  const credential = await getCredential(String(userId));
  return credential?.cookie ?? null;
}

/**
 * 将 B站 返回的图片地址统一补全为 HTTPS 完整 URL。
 * B站 部分接口会返回以 // 开头的协议相对地址或 http:// 地址，直接使用会导致前端/代理解析失败。
 */
export function normalizeBilibiliImageUrl(url: string): string {
  if (!url) return '';
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('http://')) return `https://${url.slice(7)}`;
  if (!/^https?:\/\//i.test(url)) return `https://${url}`;
  return url;
}

/** 从 B站 Cookie 中提取当前登录用户的 mid（DedeUserID） */
export function extractMidFromCookie(cookie: string): string | null {
  const match = cookie.match(/(?:^|;\s*)DedeUserID=(\d+)/);
  return match?.[1] ?? null;
}

/**
 * 从响应头中提取 Set-Cookie 中的 Cookie 名值对，合并为单一字符串。
 */
export function parseSetCookieHeader(headers: Headers): string {
  const getSetCookies = (headers as unknown as { getSetCookies?: () => string[] })
    .getSetCookies;
  let values: string[] = [];

  if (typeof getSetCookies === 'function') {
    values = getSetCookies.call(headers);
  } else {
    const single = headers.get('set-cookie');
    if (single) {
      values = single.split(',').map((s) => s.trim());
    }
  }

  return values
    .map((c) => c.split(';')[0].trim())
    .filter((c) => c.includes('='))
    .join('; ');
}

/**
 * 解析响应头中的 Set-Cookie，返回 name -> value 的 Map（只保留名值对）。
 */
export function parseSetCookieToMap(headers: Headers): Map<string, string> {
  const getSetCookies = (headers as unknown as { getSetCookies?: () => string[] })
    .getSetCookies;
  let values: string[] = [];

  if (typeof getSetCookies === 'function') {
    values = getSetCookies.call(headers);
  } else {
    const single = headers.get('set-cookie');
    if (single) {
      values = single.split(',').map((s) => s.trim());
    }
  }

  const map = new Map<string, string>();
  for (const cookie of values) {
    const [nameValue] = cookie.split(';');
    const trimmed = nameValue.trim();
    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      const name = trimmed.slice(0, eq);
      const value = trimmed.slice(eq + 1);
      map.set(name, value);
    }
  }
  return map;
}

export function cookieMapToString(map: Map<string, string>): string {
  const parts: string[] = [];
  map.forEach((value, name) => {
    parts.push(`${name}=${value}`);
  });
  return parts.join('; ');
}

/**
 * 访问二维码登录成功后返回的跨域 URL，手动跟随重定向链并收集所有 Set-Cookie。
 */
export async function fetchCookiesFromSsoUrl(
  ssoUrl: string,
): Promise<string | null> {
  try {
    const cookieMap = new Map<string, string>();
    let currentUrl = ssoUrl;
    const seenUrls = new Set<string>();
    const maxRedirects = 10;

    for (let i = 0; i <= maxRedirects; i++) {
      if (seenUrls.has(currentUrl)) {
        console.warn('[bilibili] sso redirect loop detected at', currentUrl);
        break;
      }
      seenUrls.add(currentUrl);

      const res = await fetch(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'User-Agent': DEFAULT_PROXY_UA,
          Referer: 'https://www.bilibili.com',
          ...(cookieMap.size > 0
            ? { Cookie: cookieMapToString(cookieMap) }
            : {}),
        },
      });

      const setCookies = parseSetCookieToMap(res.headers);
      for (const [name, value] of setCookies) {
        cookieMap.set(name, value);
      }

      const location = res.headers.get('location');
      if (!location) {
        break;
      }

      currentUrl = new URL(location, currentUrl).toString();
      if (res.status < 300 || res.status >= 400) {
        break;
      }
    }

    const requiredCookies = ['SESSDATA', 'bili_jct', 'DedeUserID'];
    const missing = requiredCookies.filter((name) => !cookieMap.has(name));
    if (missing.length > 0) {
      console.warn(
        '[bilibili] sso cookie missing required keys:',
        missing.join(', '),
      );
      return null;
    }

    const cookie = cookieMapToString(cookieMap);
    console.log(
      '[bilibili] sso cookie collected, keys:',
      Array.from(cookieMap.keys()).join(', '),
    );
    return cookie;
  } catch (err) {
    console.error('[bilibili] fetch sso url error:', err);
    return null;
  }
}

/**
 * 使用给定 Cookie 调用 B站 nav 接口验证登录状态并缓存用户信息。
 */
export async function validateCookieAndCacheUserInfo(
  cookie: string,
  userId: string,
): Promise<{ valid: boolean; name?: string; avatar?: string; mid?: number }> {
  try {
    const nav = await bilibiliFetch<BilibiliNavData>(
      'https://api.bilibili.com/x/web-interface/nav',
      { cookie },
    );

    if (!nav.data.isLogin) {
      console.warn('[bilibili] cookie validation failed: isLogin=false');
      return { valid: false };
    }

    const name = nav.data.uname || '';
    const avatar = normalizeBilibiliImageUrl(nav.data.face || '');
    const mid = nav.data.mid;
    const vipStatus = nav.data.vipStatus;
    const vipType = nav.data.vipType;
    setCachedUserInfo(userId, {
      name,
      avatar,
      mid,
      vipStatus,
      vipType,
    });

    return { valid: true, name, avatar, mid };
  } catch (err) {
    console.error('[bilibili] cookie validation error:', err);
    return { valid: false };
  }
}
