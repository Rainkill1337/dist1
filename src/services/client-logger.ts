/**
 * 前端浏览器控制台日志收集服务。
 *
 * 设计目的：
 * 将浏览器页面内的 console.log / warn / error 以及未捕获异常统一写入后端日志文件，
 * 与 backend/frontend 进程 stdout/stderr 日志一起集中存放在项目根目录 log/ 文件夹。
 *
 * 写入策略：
 * - 日志文件：<project-root>/log/frontend-console.log
 * - 追加写入，不阻塞请求响应。
 * - 单条日志按 [ISO8601] [LEVEL] <url> <json消息> 格式落盘。
 * - 对写入失败做静默降级，避免日志系统自身故障影响主业务。
 */
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './paths';

/** 前端日志落盘路径。 */
export const CLIENT_LOG_DIR = path.join(PROJECT_ROOT, 'log');
export const CLIENT_LOG_PATH = path.join(CLIENT_LOG_DIR, 'frontend-console.log');

/** 确保日志目录存在。 */
export function ensureClientLogDir(): void {
  if (!fs.existsSync(CLIENT_LOG_DIR)) {
    fs.mkdirSync(CLIENT_LOG_DIR, { recursive: true });
  }
}

export interface ClientLogEntry {
  /** 日志级别 */
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  /** 序列化后的消息数组 */
  messages: unknown[];
  /** 前端上报时的时间戳（ISO 8601） */
  timestamp: string;
  /** 页面 URL */
  url?: string;
  /** 用户代理 */
  userAgent?: string;
  /** 当前用户 ID（如可读取） */
  userId?: string;
  /** 当前房间 ID（如可读取） */
  roomId?: string;
}

/** 将任意消息安全序列化为字符串。 */
function stringifyMessages(messages: unknown[]): string {
  if (!messages || messages.length === 0) return '';
  try {
    return messages
      .map((m) => {
        if (typeof m === 'string') return m;
        if (m === undefined) return 'undefined';
        if (m === null) return 'null';
        if (m instanceof Error) {
          return `${m.name}: ${m.message}${m.stack ? '\n' + m.stack : ''}`;
        }
        try {
          return JSON.stringify(m);
        } catch {
          return String(m);
        }
      })
      .join(' ');
  } catch {
    return '[message serialization failed]';
  }
}

/** 写入单条前端日志到文件。 */
export function writeClientLog(entry: ClientLogEntry): void {
  try {
    ensureClientLogDir();
    const ts = entry.timestamp
      ? new Date(entry.timestamp).toISOString()
      : new Date().toISOString();
    const level = (entry.level || 'log').toUpperCase().padEnd(5);
    const metaParts: string[] = [];
    if (entry.roomId) metaParts.push(`room=${entry.roomId}`);
    if (entry.userId) metaParts.push(`user=${entry.userId}`);
    if (entry.url) metaParts.push(`url=${entry.url}`);
    const meta = metaParts.length > 0 ? ` [${metaParts.join(' ')}]` : '';
    const body = stringifyMessages(entry.messages);
    const line = `[${ts}] [${level}]${meta} ${body}\n`;
    fs.appendFileSync(CLIENT_LOG_PATH, line, { encoding: 'utf-8' });
  } catch {
    // 日志写入失败时静默丢弃，避免影响主流程
  }
}

/** 批量写入前端日志。 */
export function writeClientLogs(entries: ClientLogEntry[]): void {
  if (!entries || entries.length === 0) return;
  for (const entry of entries) {
    writeClientLog(entry);
  }
}
