/**
 * 服务器文件管理路由。
 *
 * 仅超级管理员（root）可用。提供：
 * - GET  /roots         列出所有可用根（uploads + 自定义）
 * - POST /roots         添加自定义根目录
 * - DELETE /roots/:id   删除自定义根目录
 * - GET  /browse        浏览目录
 * - GET  /browse-system 浏览服务器全盘目录（仅目录，用于添加根目录时选取）
 * - POST /upload        上传文件（multipart/form-data）
 * - POST /folder        新建文件夹
 * - POST /rename        重命名文件/文件夹
 * - DELETE /file        删除文件或文件夹
 * - GET  /resolve       解析文件 → 返回代理播放 URL + 格式
 * - GET  /proxy         流式代理播放（支持 Range）
 *
 * 路径参数采用前缀式：'uploads:/path' 或 'custom:<id>:/path'。
 * 旧式 '/path' 默认归属 uploads 根（向后兼容）。
 */
import { Router, Request, Response } from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import multer from 'multer';
import { AppDataSource } from '../data-source';
import { ServerFolder } from '../entities/ServerFolder';
import { authenticateToken, requireRoot, AuthenticatedRequest } from '../middleware/auth';
import { detectMediaFormat, getContentType } from '../services/mediaFormat';
import { parseRangeHeader, pipeRangeStream, setWildcardCors } from '../services/proxy';
import {
  UPLOADS_ROOT,
  UPLOADS_ROOT_KEY,
  resolveSafePath,
  toPrefixedPath,
  getUploadsRoot,
  basename,
  type RootRegistry,
} from '../services/server-files/pathResolver';
import {
  resolveBilibiliVideo,
  extractBvid,
  normalizeResolveError,
  type ResolveProgress,
} from '../services/bilibili/resolver';
import { VIP_ONLY_QNS } from '../services/bilibili/permission';
import { getUserCookie } from '../routes/stream/helpers';
import {
  checkFfmpeg,
  installFfmpeg,
  installFfmpegFromZip,
  mergeVideoAudio,
  downloadToFile,
  resolveFfmpegPath,
  probeMediaInfo,
  extractSubtitleTrack,
  needsAudioTranscode,
  isFfmpegTranscodeCapable,
  createAudioTranscodeStream,
  resetFfmpegCache,
  type InstallProgress,
  type SubtitleStreamInfo,
} from '../services/ffmpeg';

const router = Router();

// 全局校验：仅 root 可访问
router.use(authenticateToken, requireRoot);

// 上传文件大小上限：10GB
const MAX_UPLOAD_SIZE = 10 * 1024 * 1024 * 1024;

/** ServerFolder 仓库。 */
const folderRepo = () => AppDataSource.getRepository(ServerFolder);

/**
 * 加载所有根目录到注册表。
 * uploads 根始终存在；自定义根按数据库记录注册。
 */
async function loadRootRegistry(): Promise<RootRegistry> {
  const map: RootRegistry = new Map();
  map.set(UPLOADS_ROOT_KEY, getUploadsRoot());
  const folders = await folderRepo().find({ order: { id: 'ASC' } });
  for (const f of folders) {
    const key = `custom:${f.id}`;
    map.set(key, {
      key,
      name: f.name,
      absPath: path.resolve(f.absPath),
      readonly: !!f.readonly,
    });
  }
  return map;
}

/** multer 存储：写到目标目录（运行时按 root 解析）。 */
const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const targetDir = typeof req.body.targetDir === 'string' ? req.body.targetDir : '/';
    loadRootRegistry()
      .then((roots) => {
        try {
          const { abs, root } = resolveSafePath(targetDir, roots);
          if (root.readonly) {
            cb(new Error('该根目录为只读'), '');
            return;
          }
          if (!fs.existsSync(abs)) {
            fs.mkdirSync(abs, { recursive: true });
          }
          // 把目标目录绝对路径暂存到 req 上，filename 阶段读取以处理重名。
          // multer 保证 filename 在 destination 之后调用。
          (req as Request & { __targetDirAbs?: string }).__targetDirAbs = abs;
          cb(null, abs);
        } catch (err) {
          cb(err as Error, '');
        }
      })
      .catch((err) => cb(err as Error, ''));
  },
  filename: (req, file, cb) => {
    const dirAbs = (req as Request & { __targetDirAbs?: string }).__targetDirAbs;
    const original = Buffer.from(file.originalname, 'latin1').toString('utf8');
    if (!dirAbs) {
      cb(null, original);
      return;
    }
    // 重名时追加序号，避免覆盖已有文件
    cb(null, uniqueFilename(dirAbs, original));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_SIZE },
});

/** 重名文件追加序号（a.mp4 → a (1).mp4）。 */
function uniqueFilename(dirAbs: string, filename: string): string {
  const target = path.join(dirAbs, filename);
  if (!fs.existsSync(target)) return filename;
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  for (let i = 1; i < 10000; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!fs.existsSync(path.join(dirAbs, candidate))) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

// ============ 1. 根目录管理 ============

/** GET /roots — 列出所有根。 */
router.get('/roots', async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const roots = await loadRootRegistry();
    const list = Array.from(roots.values()).map((r) => ({
      key: r.key,
      name: r.name,
      absPath: r.absPath,
      readonly: r.readonly,
      exists: fs.existsSync(r.absPath),
    }));
    res.json({ success: true, roots: list });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : '加载根目录失败',
    });
  }
});

/** POST /roots — 添加自定义根目录。 */
router.post('/roots', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const absPath = typeof req.body.absPath === 'string' ? req.body.absPath.trim() : '';
    const readonly = req.body.readonly === true;
    if (!name) {
      res.status(400).json({ success: false, message: '名称不能为空' });
      return;
    }
    if (!absPath) {
      res.status(400).json({ success: false, message: '目录路径不能为空' });
      return;
    }
    // 规范化并禁止相对路径（避免误把工作目录拼进去）
    const resolved = path.resolve(absPath);
    // 禁止将 uploads 根自身重复添加
    if (resolved === UPLOADS_ROOT) {
      res.status(400).json({ success: false, message: '该目录已是默认空间' });
      return;
    }
    // 必须存在且为目录
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) {
        res.status(400).json({ success: false, message: '路径不是目录' });
        return;
      }
    } catch {
      res.status(400).json({ success: false, message: '目录不存在或无访问权限' });
      return;
    }
    // 防止重复添加同一路径
    const existing = await folderRepo().findOne({ where: { absPath: resolved } });
    if (existing) {
      res.status(400).json({ success: false, message: '该目录已添加' });
      return;
    }
    const entity = folderRepo().create({ name, absPath: resolved, readonly });
    const saved = await folderRepo().save(entity);
    res.json({
      success: true,
      root: {
        key: `custom:${saved.id}`,
        name: saved.name,
        absPath: saved.absPath,
        readonly: saved.readonly,
        exists: true,
      },
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : '添加根目录失败',
    });
  }
});

/** DELETE /roots/:id — 删除自定义根目录（仅删除挂载，不删真实文件）。 */
router.delete('/roots/:id', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ success: false, message: '无效的 ID' });
      return;
    }
    const entity = await folderRepo().findOne({ where: { id } });
    if (!entity) {
      res.status(404).json({ success: false, message: '根目录不存在' });
      return;
    }
    await folderRepo().remove(entity);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : '删除根目录失败',
    });
  }
});

// ============ 2. 浏览目录 ============

router.get('/browse', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const roots = await loadRootRegistry();
    const { abs, root } = resolveSafePath(req.query.path as string | undefined, roots);
    let stat;
    try {
      stat = await fsp.stat(abs);
    } catch {
      res.json({
        success: true,
        entries: [],
        currentPath: toPrefixedPath(root, abs),
        readonly: root.readonly,
      });
      return;
    }
    if (!stat.isDirectory()) {
      res.json({
        success: true,
        entries: [],
        currentPath: toPrefixedPath(root, abs),
        readonly: root.readonly,
      });
      return;
    }
    const items = await fsp.readdir(abs, { withFileTypes: true });
    const filtered = items.filter((item) => !item.name.startsWith('.'));
    const entries = await Promise.all(
      filtered.map(async (item) => {
        const childAbs = path.join(abs, item.name);
        let childStat;
        try {
          childStat = await fsp.stat(childAbs);
        } catch {
          return null;
        }
        return {
          name: item.name,
          path: toPrefixedPath(root, childAbs),
          type: item.isDirectory() ? 'directory' : 'file',
          size: item.isFile() ? childStat.size : undefined,
          modifiedAt: childStat.mtime.toISOString(),
        };
      }),
    );
    const sortedEntries = entries
      .filter((e): e is NonNullable<typeof e> => e !== null)
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name, 'zh-Hans-CN');
      });
    res.json({
      success: true,
      entries: sortedEntries,
      currentPath: toPrefixedPath(root, abs),
      readonly: root.readonly,
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      message: err instanceof Error ? err.message : '浏览目录失败',
    });
  }
});

// ============ 2.5 系统级目录浏览（用于添加根目录时选取路径） ============

/**
 * GET /browse-system — 浏览服务器文件系统任意目录（仅返回子目录）。
 *
 * 不受已注册根目录限制，可浏览服务器全盘，用于"添加自定义根目录"时选取路径。
 * 仅返回目录（隐藏文件除外），不返回文件。
 *
 * 查询参数：
 * - absPath: 要浏览的绝对路径。不提供时返回系统根（Windows 盘符列表 / Unix 根目录）。
 */
router.get('/browse-system', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const rawPath = typeof req.query.absPath === 'string' ? req.query.absPath.trim() : '';
    const isWindows = process.platform === 'win32';

    // 无路径参数：返回系统根
    if (!rawPath) {
      if (isWindows) {
        // Windows: 枚举可用盘符
        const drives: Array<{ name: string; absPath: string }> = [];
        for (let code = 65; code <= 90; code++) {
          const letter = String.fromCharCode(code);
          const drivePath = `${letter}:\\`;
          try {
            if (fs.statSync(drivePath).isDirectory()) {
              drives.push({ name: `${letter}:`, absPath: drivePath });
            }
          } catch {
            // 盘符不存在或无权限，跳过
          }
        }
        res.json({ success: true, entries: drives, currentPath: '', isRoot: true });
        return;
      }
      // Unix: 返回 / 下的目录
      const items = fs.readdirSync('/', { withFileTypes: true });
      const entries = items
        .filter((item) => item.isDirectory() && !item.name.startsWith('.'))
        .map((item) => ({ name: item.name, absPath: path.join('/', item.name) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
      res.json({ success: true, entries, currentPath: '/', isRoot: true });
      return;
    }

    // 有路径参数：列出该路径下的子目录
    const resolved = path.resolve(rawPath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      res.status(400).json({ success: false, message: '路径不存在或无访问权限' });
      return;
    }
    if (!stat.isDirectory()) {
      res.status(400).json({ success: false, message: '路径不是目录' });
      return;
    }

    const items = fs.readdirSync(resolved, { withFileTypes: true });
    const entries = items
      .filter((item) => item.isDirectory() && !item.name.startsWith('.'))
      .map((item) => ({ name: item.name, absPath: path.join(resolved, item.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));

    // 计算父目录路径（用于返回上一级），系统根时父目录为空
    let parentPath = '';
    if (isWindows) {
      // Windows: 如 D:\folder 的父级是 D:\，D:\ 的父级为空（系统根）
      const parsed = path.parse(resolved);
      if (parsed.dir && parsed.dir !== resolved) {
        parentPath = parsed.dir;
      }
    } else {
      if (resolved !== '/') {
        parentPath = path.dirname(resolved);
      }
    }

    res.json({
      success: true,
      entries,
      currentPath: resolved,
      parentPath,
      isRoot: false,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : '浏览系统目录失败',
    });
  }
});

// ============ 3. 上传文件 ============

router.post('/upload', upload.array('files', 50), async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const files = req.files as Express.Multer.File[] | undefined;
  if (!files || files.length === 0) {
    res.status(400).json({ success: false, message: '未接收到文件' });
    return;
  }
  // multer storage 已在 destination 阶段校验只读、创建目录，
  // 并在 filename 阶段应用 uniqueFilename 避免覆盖。
  // 这里重新解析 targetDir 以构造前缀式返回路径。
  const targetDir = typeof req.body.targetDir === 'string' ? req.body.targetDir : '/';
  try {
    const roots = await loadRootRegistry();
    const { abs: dirAbs, root } = resolveSafePath(targetDir, roots);
    const uploaded = files.map((f) => {
      const name = path.basename(f.path);
      const childAbs = path.join(dirAbs, name);
      return {
        name,
        path: toPrefixedPath(root, childAbs),
        size: f.size,
      };
    });
    res.json({ success: true, files: uploaded });
  } catch (err) {
    // 解析失败时清理已写入文件
    for (const f of files) {
      try { fs.unlinkSync(f.path); } catch { /* ignore */ }
    }
    res.status(400).json({
      success: false,
      message: err instanceof Error ? err.message : '上传失败',
    });
  }
});

// ============ 4. 新建文件夹 ============

router.post('/folder', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const parent = typeof req.body.parent === 'string' ? req.body.parent : '/';
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!name) {
      res.status(400).json({ success: false, message: '文件夹名称不能为空' });
      return;
    }
    if (/[\\/:*?"<>|]/.test(name)) {
      res.status(400).json({ success: false, message: '文件夹名称包含非法字符' });
      return;
    }
    const roots = await loadRootRegistry();
    const { abs: parentAbs, root } = resolveSafePath(parent, roots);
    if (root.readonly) {
      res.status(400).json({ success: false, message: '该根目录为只读' });
      return;
    }
    const targetAbs = path.join(parentAbs, name);
    if (targetAbs !== root.absPath && !targetAbs.startsWith(root.absPath + path.sep)) {
      res.status(400).json({ success: false, message: '路径越权' });
      return;
    }
    if (fs.existsSync(targetAbs)) {
      res.status(400).json({ success: false, message: '同名项目已存在' });
      return;
    }
    fs.mkdirSync(targetAbs, { recursive: true });
    res.json({ success: true, path: toPrefixedPath(root, targetAbs) });
  } catch (err) {
    res.status(400).json({
      success: false,
      message: err instanceof Error ? err.message : '新建文件夹失败',
    });
  }
});

// ============ 5. 重命名 ============

router.post('/rename', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const oldPath = typeof req.body.path === 'string' ? req.body.path : '';
    const newName = typeof req.body.newName === 'string' ? req.body.newName.trim() : '';
    if (!oldPath || !newName) {
      res.status(400).json({ success: false, message: '缺少 path 或 newName 参数' });
      return;
    }
    if (/[\\/:*?"<>|]/.test(newName)) {
      res.status(400).json({ success: false, message: '名称包含非法字符' });
      return;
    }
    const roots = await loadRootRegistry();
    const { abs: oldAbs, root } = resolveSafePath(oldPath, roots);
    if (root.readonly) {
      res.status(400).json({ success: false, message: '该根目录为只读' });
      return;
    }
    if (!fs.existsSync(oldAbs)) {
      res.status(404).json({ success: false, message: '原文件不存在' });
      return;
    }
    const parentDir = path.dirname(oldAbs);
    const newAbs = path.join(parentDir, newName);
    if (newAbs !== root.absPath && !newAbs.startsWith(root.absPath + path.sep)) {
      res.status(400).json({ success: false, message: '路径越权' });
      return;
    }
    if (fs.existsSync(newAbs) && oldAbs !== newAbs) {
      res.status(400).json({ success: false, message: '同名项目已存在' });
      return;
    }
    fs.renameSync(oldAbs, newAbs);
    res.json({ success: true, path: toPrefixedPath(root, newAbs) });
  } catch (err) {
    res.status(400).json({
      success: false,
      message: err instanceof Error ? err.message : '重命名失败',
    });
  }
});

// ============ 6. 删除文件/文件夹 ============

router.delete('/file', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const target = typeof req.query.path === 'string' ? req.query.path : '';
    if (!target || target === '/' || target.endsWith(':/') || target.endsWith(':')) {
      res.status(400).json({ success: false, message: '不能删除根目录' });
      return;
    }
    const roots = await loadRootRegistry();
    const { abs: targetAbs, root } = resolveSafePath(target, roots);
    if (root.readonly) {
      res.status(400).json({ success: false, message: '该根目录为只读' });
      return;
    }
    if (targetAbs === root.absPath) {
      res.status(400).json({ success: false, message: '不能删除根目录' });
      return;
    }
    if (!fs.existsSync(targetAbs)) {
      res.status(404).json({ success: false, message: '文件不存在' });
      return;
    }
    fs.rmSync(targetAbs, { recursive: true, force: true });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({
      success: false,
      message: err instanceof Error ? err.message : '删除失败',
    });
  }
});

// ============ 7. 解析文件 → 返回代理播放 URL ============

router.get('/resolve', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const target = typeof req.query.path === 'string' ? req.query.path : '';
    if (!target.trim()) {
      res.status(400).json({ success: false, message: '缺少 path 参数' });
      return;
    }
    const roots = await loadRootRegistry();
    const { abs: targetAbs } = resolveSafePath(target, roots);
    if (!fs.existsSync(targetAbs) || fs.statSync(targetAbs).isDirectory()) {
      res.status(404).json({ success: false, message: '文件不存在' });
      return;
    }
    const name = basename(targetAbs);
    const format = detectMediaFormat(name);
    // 使用相对路径，由前端根据当前页面 origin 自动解析，避免反向代理后协议错误（http vs https）
    const proxyUrl = `/api/server-files/proxy?path=${encodeURIComponent(target)}`;

    // 探测音频编码（用于前端判断是否需要转码提示）
    let audioCodec: string | null = null;
    let duration: number | null = null;
    let subtitleTracks: SubtitleStreamInfo[] = [];
    try {
      const probe = await probeMediaInfo(targetAbs);
      audioCodec = probe.audioCodec;
      duration = probe.duration;
      subtitleTracks = probe.subtitleStreams || [];
    } catch {
      // 探测失败不影响正常流程
    }

    res.json({
      success: true,
      title: name,
      videoUrl: proxyUrl,
      format,
      audioCodec,
      duration,
      subtitleTracks,
      size: fs.statSync(targetAbs).size,
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      message: err instanceof Error ? err.message : '解析文件失败',
    });
  }
});

// ============ 7.5 提取内嵌字幕轨道 ============

/**
 * GET /extract-subtitle — 提取视频文件中指定字幕轨道的内容。
 *
 * 查询参数：
 *   path   — 前缀式文件路径（如 'uploads:/movie.mkv'）
 *   index  — ffprobe 流索引（绝对索引，从 /resolve 返回的 subtitleTracks 中获取）
 *
 * 返回 JSON：
 *   { success: true, content, format, label }
 *   content 为 SRT 格式字幕文本，前端解析为 VTT 后使用
 */
router.get('/extract-subtitle', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const target = typeof req.query.path === 'string' ? req.query.path : '';
    const streamIndex = parseInt(String(req.query.index), 10);

    if (!target.trim()) {
      res.status(400).json({ success: false, message: '缺少 path 参数' });
      return;
    }
    if (!Number.isFinite(streamIndex) || streamIndex < 0) {
      res.status(400).json({ success: false, message: '缺少或无效的 index 参数' });
      return;
    }

    const roots = await loadRootRegistry();
    const { abs: targetAbs } = resolveSafePath(target, roots);
    if (!fs.existsSync(targetAbs) || fs.statSync(targetAbs).isDirectory()) {
      res.status(404).json({ success: false, message: '文件不存在' });
      return;
    }

    // 验证该流索引确实是字幕流
    const probe = await probeMediaInfo(targetAbs);
    const subStream = (probe.subtitleStreams || []).find(s => s.index === streamIndex);
    if (!subStream) {
      res.status(400).json({ success: false, message: '未找到指定的字幕轨道' });
      return;
    }

    const content = await extractSubtitleTrack(targetAbs, streamIndex);
    const label = subStream.title || subStream.language || `轨道 ${streamIndex}`;

    res.json({
      success: true,
      content,
      format: 'srt',
      label,
      language: subStream.language,
    });
  } catch (err) {
    console.error('[server-files] extract-subtitle error:', err);
    res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : '提取字幕失败',
    });
  }
});

// ============ 8. 流式代理播放（支持 Range） ============

/**
 * HEAD /proxy — 轻量级元数据响应（不启动 FFmpeg）。
 *
 * 前端 direct-engine 在 attach 时发送 HEAD 请求获取 X-Content-Duration，
 * 用于 fragmented MP4 转码流（video.duration=Infinity）场景下的时长回退。
 * 仅探测文件信息并返回 header，不执行转码或流式传输。
 */
router.head('/proxy', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const target = typeof req.query.path === 'string' ? req.query.path : '';
    if (!target.trim()) {
      res.status(400).end();
      return;
    }
    const roots = await loadRootRegistry();
    const { abs: targetAbs } = resolveSafePath(target, roots);
    if (!fs.existsSync(targetAbs) || fs.statSync(targetAbs).isDirectory()) {
      res.status(404).end();
      return;
    }

    const format = detectMediaFormat(target);
    const stat = fs.statSync(targetAbs);
    setWildcardCors(res);
    res.setHeader('Content-Type', getContentType(format));
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', stat.size.toString());

    // 探测时长，设置 X-Content-Duration header（供前端回退使用）
    try {
      const probe = await probeMediaInfo(targetAbs);
      if (probe.duration && probe.duration > 0) {
        res.setHeader('X-Content-Duration', probe.duration.toFixed(3));
      }
    } catch {
      // 探测失败不影响 HEAD 响应
    }

    res.status(200).end();
  } catch {
    if (!res.headersSent) {
      res.status(400).end();
    }
  }
});

router.get('/proxy', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const target = typeof req.query.path === 'string' ? req.query.path : '';
    if (!target.trim()) {
      res.status(400).json({ success: false, message: '缺少 path 参数' });
      return;
    }
    const roots = await loadRootRegistry();
    const { abs: targetAbs } = resolveSafePath(target, roots);
    if (!fs.existsSync(targetAbs) || fs.statSync(targetAbs).isDirectory()) {
      res.status(404).json({ success: false, message: '文件不存在' });
      return;
    }

    const stat = fs.statSync(targetAbs);
    const fileSize = stat.size;
    const rangeHeader = req.headers.range;
    const format = detectMediaFormat(target);

    // ── 音频转码检测 ──
    // 对于 MKV 等容器，浏览器可能不支持其音频编码（如 DTS/AC3/EAC3）。
    // 使用 ffprobe 检测音频编码，若不支持则用 FFmpeg 实时转码为 AAC。
    // 必须同时检查 FFmpeg 是否具备 AAC 编码能力（精简版 FFmpeg 不支持）。
    let transcodeNeeded = false;
    let probeDuration: number | null = null;
    if (format === 'mkv' || format === 'avi' || format === 'wmv' || format === 'ts') {
      try {
        const probe = await probeMediaInfo(targetAbs);
        probeDuration = probe.duration;
        if (needsAudioTranscode(probe.audioCodec)) {
          // 检查 FFmpeg 是否具备 AAC 编码能力
          const capable = await isFfmpegTranscodeCapable();
          if (capable) {
            transcodeNeeded = true;
            console.log(`[server-files] 音频转码: ${probe.audioCodec} → AAC, 文件: ${targetAbs}`);
          } else {
            console.warn(`[server-files] 音频需转码 (${probe.audioCodec}) 但 FFmpeg 不支持 AAC 编码，使用直接传输（可能无声音）`);
          }
        }
      } catch {
        // 探测失败，保守地直接流式传输
      }
    }

    if (transcodeNeeded) {
      // ── 转码路径：FFmpeg 实时转码音频为 AAC，输出 fragmented MP4 ──
      // 估算 seek 时间：Range 字节位置 / 文件总大小 * 时长
      let seekTime = 0;
      if (rangeHeader && probeDuration && fileSize > 0) {
        const parsed = parseRangeHeader(rangeHeader, fileSize);
        if (parsed !== 'invalid' && parsed) {
          seekTime = (parsed.start / fileSize) * probeDuration;
        }
      }

      let transcodeResult;
      try {
        transcodeResult = createAudioTranscodeStream(targetAbs, seekTime);
      } catch (err) {
        // FFmpeg 不可用，回退到直接流式传输
        console.warn('[server-files] FFmpeg 转码不可用，回退到直接传输:', err);
        transcodeNeeded = false;
      }

      if (transcodeNeeded && transcodeResult) {
        const { stream, process: ffmpegProc } = transcodeResult;

        // ── 等待 FFmpeg 产生第一块数据 ──
        // 在发送响应头之前等待 FFmpeg 实际输出数据。
        // 如果 FFmpeg 在产生数据前就退出（如编码器不存在），则回退到直接传输。
        // 超时 5 秒也视为失败。
        const firstChunk = await new Promise<Buffer | null>((resolve) => {
          let settled = false;
          const timer = setTimeout(() => {
            if (!settled) { settled = true; resolve(null); }
          }, 5000);

          stream.once('data', (chunk: Buffer) => {
            if (!settled) { settled = true; clearTimeout(timer); resolve(chunk); }
          });
          ffmpegProc.once('exit', (code) => {
            if (!settled) { settled = true; clearTimeout(timer); resolve(null); }
            if (code !== 0 && code !== null) {
              console.error(`[server-files] FFmpeg 启动失败，退出码 ${code}`);
            }
          });
          ffmpegProc.once('error', () => {
            if (!settled) { settled = true; clearTimeout(timer); resolve(null); }
          });
        });

        if (firstChunk) {
          // FFmpeg 已开始产出数据，提交转码响应
          setWildcardCors(res);
          res.setHeader('Content-Type', 'video/mp4');
          // 转码流不支持 Range，不设置 Accept-Ranges 和 Content-Length
          // 但提供探测时长，供前端在 video.duration=Infinity 时回退使用
          if (probeDuration && probeDuration > 0) {
            res.setHeader('X-Content-Duration', probeDuration.toFixed(3));
          }
          res.status(200);

          // 客户端断连时 kill FFmpeg 进程
          res.on('close', () => {
            if (!res.writableFinished) {
              try { ffmpegProc.kill('SIGKILL'); } catch { /* ignore */ }
            }
          });

          // FFmpeg stderr 仅用于错误日志
          let stderrBuffer = '';
          ffmpegProc.stderr?.on('data', (chunk: Buffer) => {
            stderrBuffer += chunk.toString();
            if (stderrBuffer.length > 4096) {
              stderrBuffer = stderrBuffer.slice(-2048);
            }
          });

          ffmpegProc.on('error', (err) => {
            console.error('[server-files] FFmpeg 进程错误:', err);
            if (!res.writableFinished) { res.destroy(); }
          });

          ffmpegProc.on('exit', (code) => {
            if (code !== 0 && code !== null) {
              console.error(`[server-files] FFmpeg 退出码 ${code}: ${stderrBuffer.slice(-500)}`);
              if (!res.writableFinished) { res.destroy(); }
            }
          });

          // 先写入第一块数据，然后 pipe 剩余数据
          res.write(firstChunk);
          stream.pipe(res);
          return;
        } else {
          // FFmpeg 未产生数据（编码器不存在或启动失败），回退到直接传输
          console.warn('[server-files] FFmpeg 转码未产生数据，回退到直接传输');
          try { ffmpegProc.kill('SIGKILL'); } catch { /* ignore */ }
          // 继续走直接流式传输路径
        }
      }
    }

    // ── 直接流式传输路径（原始逻辑）──
    if (rangeHeader) {
      const parsed = parseRangeHeader(rangeHeader, fileSize);
      if (parsed === 'invalid') {
        res.status(416).setHeader('Content-Range', `bytes */${fileSize}`);
        res.end();
        return;
      }
      const start = parsed?.start ?? 0;
      const end = parsed?.end ?? fileSize - 1;
      const stream = fs.createReadStream(targetAbs, { start, end });
      pipeRangeStream(res, {
        stream,
        contentType: getContentType(format),
        fileSize,
        start,
        end,
        ranged: true,
        logTag: 'server-files',
        errorMessage: '文件读取失败',
      });
    } else {
      const stream = fs.createReadStream(targetAbs);
      pipeRangeStream(res, {
        stream,
        contentType: getContentType(format),
        fileSize,
        ranged: false,
        logTag: 'server-files',
        errorMessage: '文件读取失败',
      });
    }
  } catch (err) {
    if (!res.headersSent) {
      res.status(400).json({
        success: false,
        message: err instanceof Error ? err.message : '代理播放失败',
      });
    }
  }
});

// ============ 9. 下载 B站 视频到服务器 ============

/**
 * GET /ffmpeg-status — 检测 FFmpeg 是否可用（内置或系统 PATH）。
 *
 * 返回：
 *   { success, available, source, path, version, transcodeCapable, error? }
 *
 * transcodeCapable: 是否具备 AAC 编码能力（精简版 FFmpeg 可能为 false）。
 * available=true 但 transcodeCapable=false 时，前端应提示安装完整版。
 *
 * 查询参数：
 *   ?force=true  强制刷新缓存，重新检测。
 */
router.get('/ffmpeg-status', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    // force=true 时重置缓存，重新检测
    if (req.query.force === 'true') {
      resetFfmpegCache();
    }
    const status = await checkFfmpeg();
    // 如果 FFmpeg 可用，进一步检测是否具备 AAC 编码能力
    const transcodeCapable = status.available
      ? await isFfmpegTranscodeCapable()
      : false;
    res.json({ success: true, ...status, transcodeCapable });
  } catch (err) {
    res.status(500).json({
      success: false,
      available: false,
      transcodeCapable: false,
      message: err instanceof Error ? err.message : '检测 FFmpeg 失败',
    });
  }
});

/**
 * POST /ffmpeg-install — 在线下载并安装 FFmpeg 到项目 bin/ 目录。
 *
 * 采用 NDJSON 流式响应推送下载/解压进度：
 *   { status: 'downloading', received, total, percent, message }
 *   { status: 'extracting', message }
 *   { status: 'done', message }
 *   { status: 'error', message }
 */
router.post('/ffmpeg-install', async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'close');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Transfer-Encoding', 'chunked');

  const send = (payload: Record<string, unknown>): void => {
    res.write(JSON.stringify(payload) + '\n');
    const flushable = res as unknown as { flush?: () => void };
    if (typeof flushable.flush === 'function') flushable.flush();
  };

  try {
    await installFfmpeg((p: InstallProgress) => {
      send({ status: p.stage, ...p });
    });
    send({ success: true, status: 'done', message: 'FFmpeg 安装完成' });
    res.end();
  } catch (err) {
    send({
      success: false,
      status: 'error',
      message: err instanceof Error ? err.message : '安装 FFmpeg 失败',
    });
    res.end();
  }
});

/**
 * POST /ffmpeg-upload — 手动上传 zip 文件安装 FFmpeg。
 *
 * 接收 multipart/form-data 中的 file 字段（zip 文件），
 * 解压并提取 ffmpeg 可执行文件到 bin/ 目录。
 *
 * 返回 JSON：
 *   { success: true, message }
 *   { success: false, message }
 */
const ffmpegUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const tmpDir = path.join(os.tmpdir(), 'ffmpeg-upload');
      fs.mkdirSync(tmpDir, { recursive: true });
      cb(null, tmpDir);
    },
    filename: (_req, file, cb) => {
      cb(null, `ffmpeg-${Date.now()}-${file.originalname}`);
    },
  }),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
  fileFilter: (_req, file, cb) => {
    if (file.originalname.toLowerCase().endsWith('.zip')) {
      cb(null, true);
    } else {
      cb(new Error('仅支持 .zip 格式的 FFmpeg 压缩包'));
    }
  },
});

router.post('/ffmpeg-upload', ffmpegUpload.single('file'), async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, message: '未收到文件' });
      return;
    }

    const zipPath = req.file.path;
    console.log(`[ffmpeg-upload] 收到上传文件: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(1)}MB)`);

    await installFfmpegFromZip(zipPath);

    // 清理上传的临时文件
    try { fs.unlinkSync(zipPath); } catch { /* ignore */ }

    // 验证安装结果
    const status = await checkFfmpeg();
    const transcodeCapable = status.available
      ? await isFfmpegTranscodeCapable()
      : false;

    res.json({
      success: status.available,
      message: status.available
        ? `FFmpeg 安装成功${transcodeCapable ? '（完整版，支持音频转码）' : '（精简版，不支持音频转码）'}`
        : '安装后仍未检测到 FFmpeg，请检查压缩包内容',
      available: status.available,
      source: status.source,
      version: status.version,
      transcodeCapable,
    });
  } catch (err) {
    // 清理上传的临时文件
    if (req.file?.path) {
      try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
    }
    console.error('[ffmpeg-upload] 安装失败:', err);
    res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : '安装失败',
    });
  }
});

/**
 * POST /bilibili-download — 解析 B站 视频并下载到服务器指定目录。
 *
 * 采用 NDJSON 流式响应，实时推送解析、下载、合并进度：
 *   { status: 'parsing', step, message }
 *   { status: 'downloading', phase: 'video'|'audio', received, total, percent }
 *   { status: 'merging', percent, message }
 *   { status: 'done', file: { name, path, size } }
 *   { status: 'error', message, code }
 *
 * 支持两种模式：
 *   - mode='mp4'（默认）：MP4 单文件直链，最高 1080P，无需 FFmpeg
 *   - mode='dash'：DASH 分离流（m4s），支持 4K/8K/HDR/杜比视界，
 *                  需要服务器安装 FFmpeg 合并音视频流
 */
router.post('/bilibili-download', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const url = typeof req.body.url === 'string' ? req.body.url.trim() : '';
  const targetDir = typeof req.body.targetDir === 'string' ? req.body.targetDir.trim() : '';
  const filename = typeof req.body.filename === 'string' ? req.body.filename.trim() : '';
  const qn =
    typeof req.body.qn === 'number' && Number.isFinite(req.body.qn)
      ? req.body.qn
      : undefined;
  const page =
    typeof req.body.page === 'number' && Number.isFinite(req.body.page)
      ? req.body.page
      : undefined;
  const mode = req.body.mode === 'dash' ? 'dash' : 'mp4';
  const userId = req.user?.userId;

  if (!url) {
    res.status(400).json({ success: false, message: '缺少视频链接或 BV 号' });
    return;
  }
  if (!extractBvid(url)) {
    res.status(400).json({ success: false, message: '无法解析 B站 BV 号' });
    return;
  }
  if (!targetDir) {
    res.status(400).json({ success: false, message: '缺少目标目录' });
    return;
  }

  // DASH 模式需要 FFmpeg
  if (mode === 'dash') {
    const ffmpegPath = resolveFfmpegPath();
    if (!ffmpegPath) {
      res.status(400).json({
        success: false,
        message: 'DASH 模式需要 FFmpeg，请先在下载面板中点击「下载 FFmpeg」',
      });
      return;
    }
  }

  // NDJSON 流式响应
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'close');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Transfer-Encoding', 'chunked');

  const send = (payload: Record<string, unknown>): void => {
    res.write(JSON.stringify(payload) + '\n');
    const flushable = res as unknown as { flush?: () => void };
    if (typeof flushable.flush === 'function') flushable.flush();
  };
  const fail = (message: string, code?: string): void => {
    send({ success: false, status: 'error', message, code });
    res.end();
  };

  // 临时文件清理列表
  const tempFiles: string[] = [];
  const cleanupTemps = (): void => {
    for (const f of tempFiles) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  };

  try {
    // 1. 解析目标目录
    const roots = await loadRootRegistry();
    const { abs: dirAbs, root } = resolveSafePath(targetDir, roots);
    if (root.readonly) {
      fail('该根目录为只读');
      return;
    }
    if (!fs.existsSync(dirAbs)) {
      fs.mkdirSync(dirAbs, { recursive: true });
    }

    // 2. 获取用户 B站 Cookie
    const cookie = (await getUserCookie(userId)) || undefined;

    // 3. 解析 B站 视频（按模式选择 preferMp4，下载场景跳过 CDN 健康检查）
    send({ status: 'parsing', step: 'resolve', message: '正在解析视频地址...' });
    const result = await resolveBilibiliVideo({
      url,
      userId: userId !== undefined ? String(userId) : undefined,
      cookie,
      qn,
      preferMp4: mode === 'mp4',
      page,
      // 下载场景跳过 CDN HEAD 健康检查（3.5s 超时），
      // 下载本身即连接验证，失败时由 backupUrl 重试
      skipCdnCheck: true,
      onProgress: (msg: ResolveProgress) => {
        send({ status: 'parsing', step: msg.step, message: msg.message });
      },
    });

    if (!result.videoUrl) {
      fail('解析失败：未获取到视频直链');
      return;
    }

    // 3.5 VIP 权限校验：非大会员账号不允许下载 VIP 专属清晰度
    // 后端 filterQualitiesByVip 已经过滤，这里作为强校验防止前端绕过
    if (qn && VIP_ONLY_QNS.includes(qn) && result.vipStatus !== 1) {
      fail(
        '该清晰度需要大会员账号，请先在个人中心绑定大会员账号后重试，或选择 1080P 及以下清晰度',
        'VIP_REQUIRED',
      );
      return;
    }

    // 4. 确定文件名
    const title = (filename || result.title || `bilibili_${Date.now()}`).replace(/[\\/:*?"<>|]/g, '_');
    const finalName = uniqueFilename(dirAbs, `${title}.mp4`);
    const targetPath = path.join(dirAbs, finalName);

    // 通用下载头（防盗链）
    const downloadHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Referer: 'https://www.bilibili.com',
      Origin: 'https://www.bilibili.com',
      ...(cookie ? { Cookie: cookie } : {}),
    };

    if (mode === 'mp4') {
      // ===== MP4 模式：单文件直接下载 =====
      send({ status: 'downloading', phase: 'video', message: '开始下载...', received: 0, total: 0, percent: 0 });

      try {
        await downloadToFile(result.videoUrl, targetPath, downloadHeaders, (received, total, percent) => {
          send({ status: 'downloading', phase: 'video', received, total, percent });
        });
      } catch (err) {
        try { fs.unlinkSync(targetPath); } catch { /* ignore */ }
        fail(`下载失败：${err instanceof Error ? err.message : '写入文件失败'}`);
        return;
      }
    } else {
      // ===== DASH 模式：视频和音频 m4s 并行下载，再用 FFmpeg 合并 =====
      const videoTmp = `${targetPath}.video.m4s`;
      const audioTmp = `${targetPath}.audio.m4s`;
      tempFiles.push(videoTmp, audioTmp);

      // 并行下载视频流和音频流（两个独立 URL，无依赖关系）
      // 优化：原串行下载改为并行，节省约 50% 下载时间
      send({ status: 'downloading', phase: 'video', message: '开始下载视频流和音频流...', received: 0, total: 0, percent: 0 });

      // 进度合并：视频流和音频流分别报告，前端按 phase 区分
      const downloadVideo = async () => {
        try {
          await downloadToFile(result.videoUrl, videoTmp, downloadHeaders, (received, total, percent) => {
            send({ status: 'downloading', phase: 'video', received, total, percent });
          });
          return true;
        } catch (err) {
          console.error('[server-files] 视频流下载失败:', err);
          return false;
        }
      };

      const downloadAudio = async (): Promise<boolean> => {
        if (!result.audioUrl) return true;
        try {
          await downloadToFile(result.audioUrl, audioTmp, downloadHeaders, (received, total, percent) => {
            send({ status: 'downloading', phase: 'audio', received, total, percent });
          });
          return true;
        } catch (err) {
          console.error('[server-files] 音频流下载失败:', err);
          return false;
        }
      };

      // 并行下载：Promise.all 同时拉取两个流
      const [videoOk, audioOk] = await Promise.all([downloadVideo(), downloadAudio()]);

      if (!videoOk) {
        cleanupTemps();
        fail('视频流下载失败，请检查网络连接或稍后重试');
        return;
      }
      if (!audioOk && result.audioUrl) {
        cleanupTemps();
        fail('音频流下载失败，请检查网络连接或稍后重试');
        return;
      }

      // 4.3 FFmpeg 合并
      send({ status: 'merging', percent: 0, message: '正在合并音视频流...' });
      try {
        await mergeVideoAudio({
          videoPath: videoTmp,
          audioPath: result.audioUrl ? audioTmp : undefined,
          outputPath: targetPath,
          duration: result.duration > 0 ? result.duration : undefined,
          onProgress: (percent, message) => {
            send({ status: 'merging', percent, message });
          },
        });
      } catch (err) {
        cleanupTemps();
        try { fs.unlinkSync(targetPath); } catch { /* ignore */ }
        fail(`合并失败：${err instanceof Error ? err.message : 'FFmpeg 合并失败'}`);
        return;
      }

      // 4.4 清理临时 m4s 文件
      cleanupTemps();
    }

    // 5. 完成
    const size = fs.statSync(targetPath).size;
    send({
      success: true,
      status: 'done',
      file: {
        name: finalName,
        path: toPrefixedPath(root, targetPath),
        size,
      },
    });
    res.end();
  } catch (err) {
    console.error('[server-files] bilibili-download error:', err);
    cleanupTemps();
    const normalized = normalizeResolveError(err);
    fail(normalized.message, normalized.code);
  }
});

export default router;
