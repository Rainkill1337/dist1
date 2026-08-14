/**
 * FTP 直连接解析与代理（需登录态，由父路由统一 authenticateToken）。
 *
 *   GET /resolve-ftp  按 query 中的连接参数解析文件，返回 /proxy-ftp 播放地址
 *   GET /proxy-ftp    FTP 流式代理
 *
 * 与 /api/ftp/*（按 mountId 查库）不同，此链路面向未保存挂载的临时连接，
 * 连接参数随 query 传递。
 */

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth';
import { statFTPFile, createFTPReadStream } from '../../services/ftp';
import { pipeRangeStream } from '../../services/proxy';

const router = Router();

interface FtpQueryParams {
  serverUrl: string;
  path: string;
  username?: string;
  password?: string;
  port?: number;
}

function readFtpParams(
  req: AuthenticatedRequest,
  res: Response,
): FtpQueryParams | null {
  const { serverUrl, path, username, password, port } = req.query;
  if (
    typeof serverUrl !== 'string' ||
    !serverUrl.trim() ||
    typeof path !== 'string' ||
    !path.trim()
  ) {
    res.status(400).json({ success: false, message: '缺少服务器地址或路径' });
    return null;
  }
  return {
    serverUrl: serverUrl.trim(),
    path: path.trim(),
    username: typeof username === 'string' ? username : undefined,
    password: typeof password === 'string' ? password : undefined,
    port:
      typeof port === 'string' && port.trim() ? Number(port.trim()) : undefined,
  };
}

function buildProxyUrl(
  _req: AuthenticatedRequest,
  type: string,
  params: Record<string, string>,
): string {
  // 使用相对路径，由前端根据当前页面 origin 自动解析，避免反向代理后协议错误（http vs https）
  const query = new URLSearchParams(params).toString();
  return `/api/stream/proxy-${type}?${query}`;
}

// FTP 解析
router.get('/resolve-ftp', async (req: AuthenticatedRequest, res: Response) => {
  const params = readFtpParams(req, res);
  if (!params) return;

  try {
    const info = await statFTPFile(params);

    const proxyUrl = buildProxyUrl(req, 'ftp', {
      serverUrl: params.serverUrl,
      path: params.path,
      username: params.username ?? '',
      password: params.password ?? '',
      port: String(params.port ?? 21),
    });

    res.json({
      success: true,
      title: info.name,
      videoUrl: proxyUrl,
      format: 'mp4',
      duration: 0,
    });
  } catch (err) {
    console.error('[stream] resolve-ftp error:', err);
    res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : '解析 FTP 文件失败',
    });
  }
});

// FTP 流式代理（全量输出，不支持 Range；保持与历史行为一致）
router.get('/proxy-ftp', async (req: AuthenticatedRequest, res: Response) => {
  const params = readFtpParams(req, res);
  if (!params) return;

  try {
    const stream = createFTPReadStream(params);
    pipeRangeStream(res, {
      stream,
      contentType: 'video/mp4',
      ranged: false,
      // 历史行为：未手动设置 CORS，交由全局 cors 中间件
      cors: 'global',
      logTag: 'stream',
      errorMessage: 'FTP 代理失败',
    });
  } catch (err) {
    console.error('[stream] proxy-ftp error:', err);
    res.status(502).json({ success: false, message: 'FTP 代理失败' });
  }
});

export default router;
