/**
 * 前端浏览器控制台日志上报路由。
 *
 * 允许浏览器将页面内 console 输出批量上报到后端，由后端统一写入 log/frontend-console.log。
 * 该端点不强制鉴权，但会读取 cookie 中的 access_token 以附加 userId 到日志。
 */
import { Router, Request } from 'express';
import { writeClientLogs, type ClientLogEntry } from '../services/client-logger';
import { verifyAccessToken } from '../middleware/auth';

const router = Router();

interface ClientLogBatchBody {
  entries?: ClientLogEntry[];
}

/** 从请求中解析当前用户 ID（不抛错，解析失败返回 undefined）。 */
function extractUserIdFromCookie(req: Request): string | undefined {
  try {
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) return undefined;
    const cookies = Object.fromEntries(
      cookieHeader.split(';').map((c) => {
        const [k, ...v] = c.trim().split('=');
        return [k, decodeURIComponent(v.join('='))];
      }),
    );
    const token = cookies.access_token;
    if (!token) return undefined;
    const payload = verifyAccessToken(token);
    return String(payload.userId);
  } catch {
    return undefined;
  }
}

router.post('/', (req, res) => {
  const body = req.body as ClientLogBatchBody;
  const entries = body?.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    res.status(400).json({ success: false, message: 'entries 必须是数组' });
    return;
  }

  const userId = extractUserIdFromCookie(req);
  const enriched = entries.map((entry) => ({
    ...entry,
    userId: entry.userId || userId,
  }));

  // 异步写入，不阻塞响应
  setImmediate(() => {
    writeClientLogs(enriched);
  });

  res.status(204).send();
});

export default router;
