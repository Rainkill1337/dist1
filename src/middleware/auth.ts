import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

import type { UserRole } from '../entities/User';

export interface JwtPayload {
  userId: number;
  role: UserRole;
  username?: string;
}

export interface AuthenticatedRequest extends Request {
  user?: JwtPayload;
}

const JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-in-production';
const JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret-change-in-production';
const JWT_ACCESS_EXPIRES_IN: jwt.SignOptions['expiresIn'] =
  (process.env.JWT_ACCESS_EXPIRES_IN as jwt.SignOptions['expiresIn']) || '1h';
const JWT_REFRESH_EXPIRES_IN: jwt.SignOptions['expiresIn'] =
  (process.env.JWT_REFRESH_EXPIRES_IN as jwt.SignOptions['expiresIn']) || '30d';

/** access_token cookie 有效期（毫秒）。比 JWT 短 5 秒避免边界过期。 */
const ACCESS_COOKIE_MAX_AGE = 60 * 60 * 1000; // 1 小时
/** refresh_token cookie 有效期（毫秒）。 */
const REFRESH_COOKIE_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 天

const IS_PROD = process.env.NODE_ENV === 'production';

export function generateTokens(userId: number, role: UserRole, username?: string) {
  const payload: JwtPayload = { userId, role, username };
  const accessToken = jwt.sign(payload, JWT_ACCESS_SECRET, {
    expiresIn: JWT_ACCESS_EXPIRES_IN,
  });
  const refreshToken = jwt.sign(payload, JWT_REFRESH_SECRET, {
    expiresIn: JWT_REFRESH_EXPIRES_IN,
  });
  return { accessToken, refreshToken };
}

export function verifyAccessToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_ACCESS_SECRET) as JwtPayload;
}

export function verifyRefreshToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_REFRESH_SECRET) as JwtPayload;
}

/**
 * 判断当前请求是否为 HTTPS（含反向代理终止 TLS 的场景）。
 * 用于动态决定 cookie 的 secure 属性：
 * - HTTPS 请求 → secure: true（浏览器才允许设置 Secure cookie）
 * - HTTP 请求 → secure: false（否则浏览器会直接丢弃 Secure cookie，导致登录态丢失）
 *
 * 依赖 app.set('trust proxy', true) 才能正确读取 X-Forwarded-Proto 头。
 */
function isRequestSecure(req: Request): boolean {
  // req.secure 在直连场景下反映真实 TLS；反向代理后需信任 X-Forwarded-Proto
  if (req.secure) return true;
  const xfp = req.headers['x-forwarded-proto'];
  if (typeof xfp === 'string' && xfp.split(',')[0].trim().toLowerCase() === 'https') {
    return true;
  }
  return false;
}

/**
 * 判断当前请求是否为跨站请求（schemeful same-site 判定）。
 *
 * 浏览器 SameSite 同站判定规则（MDN：SameSite cookies）：
 * - 同站 = 相同 scheme（http/https）+ 相同 registrable domain（域名或 IP），**端口不影响同站**
 * - 例：http://example.com:3000 与 http://example.com:3333 是【同站】
 *   （同 scheme、同域名，仅端口不同，SameSite=Lax 的 cookie 可正常携带）
 *   https://example.com 与 http://example.com 则是【跨站】（scheme 不同）
 *
 * 为什么必须忽略端口：
 * 统一端口后前后端共用同一端口（默认 3333），但浏览器 SameSite 判定本身也忽略端口，
 * 因此即使历史部署中前后端使用不同端口（如前端 4173、后端 3333）也是同站。
 * 若按"端口不同即跨站"判定，会错误地把同站请求标记为跨站：
 * - HTTPS 下会错误设置 SameSite=None（同站不需要，且部分代理/浏览器对 None 敏感）
 * - HTTP 下虽因浏览器同站判定忽略端口而侥幸可用，但逻辑错误
 *
 * 兼容反向代理：
 * - 反代时请求 Host 可能被改写为内网地址（localhost:3333），
 *   优先读取 X-Forwarded-Host（反代常用 proxy_set_header X-Forwarded-Host $host）
 *   或直接比较 X-Forwarded-Proto 与 Origin 的 scheme。
 */
function isCrossSiteRequest(req: Request): boolean {
  const origin = req.headers.origin;
  if (!origin || typeof origin !== 'string') return false;

  // 请求方视角的 scheme（优先 X-Forwarded-Proto，其次 req.secure / 直连协议）
  const xfp = req.headers['x-forwarded-proto'];
  const reqScheme =
    (typeof xfp === 'string' ? xfp.split(',')[0].trim() : '') ||
    (req.secure ? 'https' : 'http');

  // 请求方视角的 host（优先 X-Forwarded-Host，其次 Host 头）
  const xfh = req.headers['x-forwarded-host'];
  const rawHost = typeof xfh === 'string' ? xfh : req.headers.host;
  if (!rawHost) return false;

  try {
    const originUrl = new URL(origin);
    // 用构造 URL 的方式解析 host（兼容 IPv6 [::1]:3333）
    const hostUrl = new URL(`${reqScheme}://${rawHost}`);
    return (
      originUrl.hostname !== hostUrl.hostname ||
      originUrl.protocol !== hostUrl.protocol
    );
  } catch {
    return false;
  }
}

/**
 * 根据请求上下文计算 cookie 的 sameSite 和 secure 属性。
 *
 * - 同站 + HTTP → sameSite: 'lax', secure: false（最常见：Nginx 反代 / 同域名不同端口）
 * - 同站 + HTTPS → sameSite: 'lax', secure: true
 * - 跨站 + HTTPS → sameSite: 'none', secure: true（跨站 fetch 携带 cookie 必需）
 * - 跨站 + HTTP  → sameSite: 'lax', secure: false（浏览器安全限制：SameSite=None 必须配 Secure，
 *   而 HTTP 无法设置 Secure cookie，因此跨站 HTTP 场景无法保留登录态。
 *   这是浏览器硬限制，需通过同站反代或升级 HTTPS 解决，代码已注释说明）
 */
function getCookieSameSiteOptions(req: Request): {
  sameSite: 'none' | 'lax';
  secure: boolean;
} {
  const secure = isRequestSecure(req);
  const crossSite = isCrossSiteRequest(req);
  if (crossSite && secure) {
    return { sameSite: 'none', secure: true };
  }
  return { sameSite: 'lax', secure };
}

/**
 * 将 access_token / refresh_token 写入 httpOnly cookie（分离式架构）。
 *
 * - HTTPS 请求：写入 httpOnly cookie（同站 Lax / 跨站 None+Secure），浏览器自动携带。
 * - HTTP 请求：不写 cookie。浏览器拒绝跨站 http cookie（SameSite=None 必须配 Secure，
 *   而 HTTP 无法设置），为避免半失效 cookie 残留，HTTP 场景统一走 Bearer token——
 *   调用方需将 token 放入响应体（登录/刷新接口已返回 tokens）。
 */
export function setAuthCookies(
  req: Request,
  res: Response,
  accessToken: string,
  refreshToken: string,
): void {
  if (!isRequestSecure(req)) return;
  const { sameSite, secure } = getCookieSameSiteOptions(req);
  res.cookie('access_token', accessToken, {
    httpOnly: true,
    secure,
    sameSite,
    maxAge: ACCESS_COOKIE_MAX_AGE,
    path: '/',
  });
  res.cookie('refresh_token', refreshToken, {
    httpOnly: true,
    secure,
    sameSite,
    maxAge: REFRESH_COOKIE_MAX_AGE,
    path: '/',
  });
}

/**
 * 仅更新 access_token cookie（refresh 不轮换）。
 * 与 setAuthCookies 相同：HTTP 请求不写 cookie，token 由响应体返回走 Bearer。
 */
export function setAccessTokenCookie(
  req: Request,
  res: Response,
  accessToken: string,
): void {
  if (!isRequestSecure(req)) return;
  const { sameSite, secure } = getCookieSameSiteOptions(req);
  res.cookie('access_token', accessToken, {
    httpOnly: true,
    secure,
    sameSite,
    maxAge: ACCESS_COOKIE_MAX_AGE,
    path: '/',
  });
}

/**
 * 清除 auth cookie（登出）。需传入 req 以匹配 sameSite 设置，
 * 否则跨站 cookie 无法被正确清除。HTTP 场景无 cookie 时调用无害。
 */
export function clearAuthCookies(req: Request, res: Response): void {
  const { sameSite, secure } = getCookieSameSiteOptions(req);
  res.clearCookie('access_token', { path: '/', sameSite, secure });
  res.clearCookie('refresh_token', { path: '/', sameSite, secure });
}

/** 从 cookie、Authorization Header 或查询参数读取 access token。 */
export function extractAccessToken(req: Request): string | undefined {
  // 从查询参数读取（用于 hls.js 等无法设置 header 的场景）
  const queryToken = req.query?.token;
  if (typeof queryToken === 'string' && queryToken) return queryToken;
  // 优先从 cookie 读取（前端 fetch credentials: 'include' 自动携带）
  const cookieToken = req.cookies?.access_token;
  if (typeof cookieToken === 'string' && cookieToken) return cookieToken;
  // 兼容旧 Authorization: Bearer <token> 头
  const authHeader = req.headers.authorization;
  const headerToken = authHeader?.split(' ')[1];
  if (headerToken) return headerToken;
  return undefined;
}

export function authenticateToken(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  const token = extractAccessToken(req);

  if (!token) {
    res.status(401).json({ success: false, message: '未提供认证令牌' });
    return;
  }

  try {
    const payload = verifyAccessToken(token);
    req.user = payload;
    next();
  } catch (err) {
    res.status(403).json({ success: false, message: '认证令牌无效或已过期' });
  }
}

/** 仅允许 root 超级管理员访问的路由中间件。 */
export function requireRoot(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  if (req.user?.role !== 'root') {
    res.status(403).json({ success: false, message: '无权限：仅超级管理员可操作' });
    return;
  }
  next();
}
