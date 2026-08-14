import { Router, raw } from 'express';
import type { Response } from 'express';
import {
  authenticateToken,
  AuthenticatedRequest,
} from '../middleware/auth';
import {
  getUpdateInfo,
  applyUpdate,
  applyUpdateFromFile,
  type UpdateStageEvent,
} from '../services/updater';

const router = Router();

function rootOnly(
  req: AuthenticatedRequest,
  res: import('express').Response,
  next: import('express').NextFunction,
) {
  if (req.user?.role !== 'root') {
    res.status(403).json({ success: false, message: '无权限：仅 root 可操作' });
    return;
  }
  next();
}

router.use(authenticateToken, rootOnly);

/**
 * 向 SSE 客户端推送一个事件。
 * SSE 协议格式：`data: <json>\n\n`，前端用 ReadableStream 读取并按 `\n\n` 分割。
 *
 * 内部检查 res.writableEnded，避免客户端提前断开后写入已关闭的响应导致崩溃。
 */
function sendSSE(res: Response, event: UpdateStageEvent): void {
  if (res.writableEnded) return;
  try {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  } catch {
    // 客户端已断开，忽略写入错误
  }
}

/** 检查更新 */
router.get(
  '/check',
  async (
    req: AuthenticatedRequest,
    res: import('express').Response,
  ): Promise<void> => {
    try {
      const includePrerelease = req.query.includePrerelease === 'true';
      const info = await getUpdateInfo(includePrerelease);
      res.json({ success: true, info });
    } catch (err) {
      console.error('update check error:', err);
      res.status(500).json({
        success: false,
        message: err instanceof Error ? err.message : '检查更新失败',
      });
    }
  },
);

/**
 * 从 GitHub Releases 下载并应用更新（SSE 流式响应）。
 *
 * 与旧版 POST /apply 的区别：返回 `text/event-stream`，
 * 逐步推送 downloading / extracting / starting / done / error 事件，
 * 前端可实时展示下载进度条与阶段提示。
 *
 * 注意：仍保留 POST /apply 作为无进度的兼容接口。
 */
router.post(
  '/apply-stream',
  async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    // 设置 SSE 响应头（不显式设置 Connection 等 hop-by-hop 头部，避免代理冲突）
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    try {
      const includePrerelease = req.query.includePrerelease === 'true';
      await applyUpdate(includePrerelease, (event) => sendSSE(res, event));
    } catch (err) {
      console.error('update apply-stream error:', err);
      sendSSE(res, {
        stage: 'error',
        message: err instanceof Error ? err.message : '应用更新失败',
      });
    } finally {
      res.end();
    }
  },
);

/** 从 GitHub Releases 下载并应用更新（无进度，兼容旧接口） */
router.post(
  '/apply',
  async (
    req: AuthenticatedRequest,
    res: import('express').Response,
  ): Promise<void> => {
    try {
      const includePrerelease = req.query.includePrerelease === 'true';
      const result = await applyUpdate(includePrerelease);
      res.json(result);
    } catch (err) {
      console.error('update apply error:', err);
      res.status(500).json({
        success: false,
        message: err instanceof Error ? err.message : '应用更新失败',
      });
    }
  },
);

/**
 * 上传压缩包并应用更新（SSE 流式响应）。
 *
 * 接收原始文件体（Content-Type: application/zip 或 application/gzip），
 * 不使用 multipart/form-data，避免引入 multer 依赖。
 * 前端直接将 File 对象作为 fetch body 发送，上传进度由浏览器 XHR 跟踪；
 * 服务端接收完毕后通过 SSE 推送 extracting / starting / done / error 事件。
 */
router.post(
  '/upload-stream',
  // 使用 express.raw 接收二进制文件数据，支持 zip 和 gzip 格式
  // 限制 500MB 以容纳大型构建产物
  raw({
    type: [
      'application/zip',
      'application/gzip',
      'application/octet-stream',
      'application/x-zip-compressed',
    ],
    limit: '500mb',
  }),
  async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    // 先校验文件数据，失败时返回普通 JSON 错误（此时还未切换到 SSE）
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ success: false, message: '未收到有效的文件数据' });
      return;
    }

    // 从 Content-Type 或查询参数推断文件名
    const contentType = req.headers['content-type'] || '';
    let filename = 'uploaded-update.zip';
    if (contentType.includes('gzip') || contentType.includes('tar')) {
      filename = 'uploaded-update.tar.gz';
    }
    const queryName = req.query.filename as string | undefined;
    if (queryName) {
      filename = queryName;
    }

    // 切换为 SSE 流式响应（不显式设置 Connection 等 hop-by-hop 头部，避免代理冲突）
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    try {
      await applyUpdateFromFile(req.body, filename, (event) =>
        sendSSE(res, event),
      );
    } catch (err) {
      console.error('update upload-stream error:', err);
      sendSSE(res, {
        stage: 'error',
        message: err instanceof Error ? err.message : '上传更新失败',
      });
    } finally {
      res.end();
    }
  },
);

/**
 * 上传压缩包并应用更新（无进度，兼容旧接口）。
 *
 * 接收原始文件体（Content-Type: application/zip 或 application/gzip），
 * 不使用 multipart/form-data，避免引入 multer 依赖。
 * 前端直接将 File 对象作为 fetch body 发送。
 */
router.post(
  '/upload',
  // 使用 express.raw 接收二进制文件数据，支持 zip 和 gzip 格式
  // 限制 500MB 以容纳大型构建产物
  raw({
    type: [
      'application/zip',
      'application/gzip',
      'application/octet-stream',
      'application/x-zip-compressed',
    ],
    limit: '500mb',
  }),
  async (
    req: AuthenticatedRequest,
    res: import('express').Response,
  ): Promise<void> => {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        res.status(400).json({ success: false, message: '未收到有效的文件数据' });
        return;
      }

      // 从 Content-Type 或查询参数推断文件名
      const contentType = req.headers['content-type'] || '';
      let filename = 'uploaded-update.zip';
      if (contentType.includes('gzip') || contentType.includes('tar')) {
        filename = 'uploaded-update.tar.gz';
      }

      // 从查询参数获取文件名（优先）
      const queryName = req.query.filename as string | undefined;
      if (queryName) {
        filename = queryName;
      }

      const result = await applyUpdateFromFile(req.body, filename);
      res.json(result);
    } catch (err) {
      console.error('update upload error:', err);
      res.status(500).json({
        success: false,
        message: err instanceof Error ? err.message : '上传更新失败',
      });
    }
  },
);

export default router;
