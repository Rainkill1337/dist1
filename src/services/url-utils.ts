/**
 * URL 工具函数
 *
 * 处理直链 URL 的协议升级，解决 HTTPS 前端加载 HTTP 资源时的混合内容（Mixed Content）问题。
 */
import type { Request } from 'express';

/**
 * 当请求来自 HTTPS 前端时，将 HTTP 直链 URL 升级为 HTTPS。
 *
 * 浏览器在 HTTPS 页面中加载 HTTP 资源时会阻止混合内容（Mixed Content），
 * 导致视频无法播放。此函数通过检查 x-forwarded-proto 头判断请求是否来自 HTTPS，
 * 如果是，则将直链 URL 的协议从 http:// 升级为 https://。
 *
 * 注意：这假设媒体服务器也支持 HTTPS 访问（直接或通过反向代理）。
 * 如果不支持，用户应使用代理模式而非直链模式。
 */
export function upgradeToHttpsIfNeeded(req: Request, url: string): string {
  if (!url || !url.startsWith('http://')) return url;

  const forwardedProto = req.headers['x-forwarded-proto'];
  const isHttps =
    forwardedProto === 'https' ||
    (Array.isArray(forwardedProto) && forwardedProto.includes('https')) ||
    req.protocol === 'https';

  if (isHttps) {
    return 'https://' + url.slice(7);
  }

  return url;
}
