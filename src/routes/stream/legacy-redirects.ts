/**
 * 兼容重定向（需登录态，由父路由统一 authenticateToken）。
 *
 * WebDAV / OpenList 的解析与代理已迁移到独立路由，这里保留 301 以兼容旧客户端：
 *   /resolve-webdav   → /api/webdav/resolve
 *   /proxy-webdav     → /api/webdav/proxy
 *   /resolve-openlist → /api/openlist/resolve
 *   /proxy-openlist   → /api/openlist/proxy
 */

import { Router } from 'express';

const router = Router();

router.get('/resolve-webdav', (req, res) => {
  const { serverUrl, path, username, password } = req.query;
  const params = new URLSearchParams();
  if (serverUrl) params.set('serverUrl', serverUrl as string);
  if (path) params.set('path', path as string);
  if (username) params.set('username', username as string);
  if (password) params.set('password', password as string);
  res.redirect(301, `/api/webdav/resolve?${params.toString()}`);
});

router.get('/proxy-webdav', (req, res) => {
  const { serverUrl, path, username, password } = req.query;
  const params = new URLSearchParams();
  if (serverUrl) params.set('serverUrl', serverUrl as string);
  if (path) params.set('path', path as string);
  if (username) params.set('username', username as string);
  if (password) params.set('password', password as string);
  res.redirect(301, `/api/webdav/proxy?${params.toString()}`);
});

router.get('/resolve-openlist', (req, res) => {
  const url = req.query.url;
  res.redirect(301, `/api/openlist/resolve?url=${encodeURIComponent(url as string)}`);
});

router.get('/proxy-openlist', (req, res) => {
  const url = req.query.url;
  res.redirect(301, `/api/openlist/proxy?url=${encodeURIComponent(url as string)}`);
});

export default router;
