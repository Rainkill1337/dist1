/**
 * /api/stream 路由聚合入口。
 *
 * 子路由划分：
 *   proxy.ts            /proxy-image（免认证）、/proxy（B站 CDN 媒体代理）
 *   bilibili-auth.ts    /bilibili/qr、login-status、logout、user-info、番剧关注/集数
 *   resolve.ts          /resolve-bilibili（NDJSON 流式解析）、/bilibili/danmaku
 *   ftp.ts              /resolve-ftp、/proxy-ftp（query 直连参数）
 *   legacy-redirects.ts /resolve-webdav 等 301 兼容重定向
 *
 * 挂载顺序注意：/proxy-image 供 img 标签使用、免认证，必须先于 authenticateToken 注册。
 */

import { Router } from 'express';
import { authenticateToken } from '../../middleware/auth';
import mediaProxyRouter, { imageProxyRouter } from './proxy';
import bilibiliAuthRouter from './bilibili-auth';
import resolveRouter from './resolve';
import ftpRouter from './ftp';
import legacyRedirectsRouter from './legacy-redirects';

const router = Router();

// 免认证端点（img 标签无法携带认证头）
router.use(imageProxyRouter);

// 其余端点均需登录态
router.use(authenticateToken);
router.use(bilibiliAuthRouter);
router.use(resolveRouter);
router.use(mediaProxyRouter);
router.use(ftpRouter);
router.use(legacyRedirectsRouter);

export default router;
