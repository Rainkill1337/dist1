/**
 * 项目数据路径集中管理。
 *
 * 设计目的：
 * 将所有运行时产生的数据文件统一收纳到项目根目录的 `config/` 文件夹下，
 * 便于升级时仅保留 `config/` 目录即可不丢失任何用户数据。
 *
 * 目录结构：
 * ```
 * <project-root>/config/
 *   ├── dev.sqlite          # SQLite 数据库（用户、房间、B站 cookie、影片列表等全部表）
 *   ├── uploads/            # 用户上传文件根目录（服务器文件模块默认根）
 *   │   └── avatars/        # 用户头像
 *   └── media/              # NMS 推流产生的临时 HTTP-FLV 切片
 * ```
 *
 * 升级流程：
 *   1. 解压新版本 zip 包到任意位置
 *   2. 将旧版本的 `config/` 目录整体复制覆盖到新版本根目录
 *   3. 执行 `npm install --omit=dev && npm start` 即可恢复全部数据
 *
 * 路径解析规则：
 * - 优先使用环境变量（DATABASE_URL / UPLOADS_DIR / MEDIA_DIR / AVATARS_DIR），
 *   便于 Docker 挂载、独立磁盘等场景灵活配置。
 * - 默认值统一为项目根 `config/` 下的子目录，相对 backend 工作目录解析。
 */
import path from 'node:path';
import fs from 'node:fs';

/**
 * 项目根目录。
 *
 * 常规运行（ts-node / node dist/index.js）时：
 *   编译后路径为 `backend/dist/services/paths.js`，上溯 3 层即可到达项目根。
 *
 * pkg 打包后（exe 运行）：
 *   __dirname 指向虚拟文件系统（只读），改用 process.cwd() 作为项目根。
 *   用户需在 exe 所在目录（或通过 CONFIG_DIR 环境变量）放置 config/ 目录。
 */
export const PROJECT_ROOT = process.env.PROJECT_ROOT
  ? process.env.PROJECT_ROOT
  : process.pkg
    ? process.cwd()
    : path.resolve(__dirname, '..', '..', '..');

/**
 * 数据根目录：所有持久化数据的统一入口。
 *
 * 默认 `<project-root>/config/`，可通过 `CONFIG_DIR` 环境变量覆盖。
 * Docker 场景下由 docker-compose.linux-single.yml 挂载到 named volume。
 */
export const CONFIG_DIR =
  process.env.CONFIG_DIR || path.join(PROJECT_ROOT, 'config');

/**
 * SQLite 数据库文件路径。
 *
 * 解析规则：
 * - DATABASE_URL 未设置：使用默认值 <CONFIG_DIR>/dev.sqlite
 * - DATABASE_URL 为绝对路径：按原样使用（如 Docker 的 /app/config/dev.sqlite）
 * - DATABASE_URL 为相对路径：相对 CONFIG_DIR 解析（而非 process.cwd()），
 *   确保旧版本 .env 中 DATABASE_URL=dev.sqlite 也能正确指向 config/dev.sqlite
 */
export const DATABASE_PATH = process.env.DATABASE_URL
  ? path.isAbsolute(process.env.DATABASE_URL)
    ? process.env.DATABASE_URL
    : path.join(CONFIG_DIR, process.env.DATABASE_URL)
  : path.join(CONFIG_DIR, 'dev.sqlite');

/** 用户上传文件根目录（服务器文件模块默认根）。 */
export const UPLOADS_DIR =
  process.env.UPLOADS_DIR || path.join(CONFIG_DIR, 'uploads');

/** 用户头像存储目录。 */
export const AVATARS_DIR =
  process.env.AVATARS_DIR || path.join(UPLOADS_DIR, 'avatars');

/** NMS 推流媒体临时目录。 */
export const MEDIA_DIR =
  process.env.MEDIA_DIR || path.join(CONFIG_DIR, 'media');

/**
 * 确保所有数据目录存在。在 backend 启动时调用一次。
 *
 * 创建顺序：CONFIG_DIR → UPLOADS_DIR → AVATARS_DIR → MEDIA_DIR
 * 已存在的目录不会被重建（mkdirSync recursive 特性）。
 */
export function ensureDataDirs(): void {
  const dirs = [CONFIG_DIR, UPLOADS_DIR, AVATARS_DIR, MEDIA_DIR];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
  // 兜底：确保数据库文件所在目录存在（DATABASE_URL 指向自定义/挂载路径时目录可能尚未创建），
  // 否则 sql.js 的 autoSave 会在首次写入时报 ENOENT 导致后端启动失败
  const dbDir = path.dirname(DATABASE_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
}

/**
 * 旧版数据迁移：将 `backend/dev.sqlite`、`backend/uploads/` 迁移到新的 `config/` 目录结构。
 *
 * 迁移触发条件：
 * 1. `DATABASE_URL` 未设置（使用新默认值 config/dev.sqlite），或为相对路径（旧版本 .env 行为）。
 *    绝对路径视为用户显式指定（如 Docker 的 /app/config/dev.sqlite），跳过迁移。
 * 2. 目标 `config/dev.sqlite` 不存在（避免覆盖已有数据）。
 * 3. 旧文件存在于 `backend/dev.sqlite`。
 *
 * 迁移策略：
 * - dev.sqlite：移动文件（含 WAL/SHM/journal 临时文件）
 * - uploads/：移动整个目录（含 avatars 子目录与用户上传的视频文件）
 * - media/：跳过（运行时临时切片，无需保留）
 *
 * 迁移失败仅打印警告，不阻断启动——最坏情况下用户数据仍位于旧路径，
 * 后续可手动复制。迁移成功后旧路径文件被移动（非复制），避免重复占用空间。
 */
export function migrateLegacyDataIfNeeded(): {
  migrated: string[];
  warnings: string[];
} {
  const migrated: string[] = [];
  const warnings: string[] = [];
  const backendDir = path.resolve(PROJECT_ROOT, 'backend');

  // 确保目标目录存在
  ensureDataDirs();

  // 1. 迁移 dev.sqlite
  // 迁移触发条件：
  // - DATABASE_URL 未设置（使用新默认值 config/dev.sqlite），或为相对路径（旧版本 .env 行为）
  //   绝对路径视为用户显式指定（如 Docker 的 /app/config/dev.sqlite），跳过迁移
  // - config/dev.sqlite 不存在（避免覆盖已有数据）
  // - backend/dev.sqlite 存在（有旧数据可迁移）
  const oldDbPath = path.join(backendDir, 'dev.sqlite');
  const targetDbPath = path.join(CONFIG_DIR, 'dev.sqlite');
  const shouldMigrateDb =
    (!process.env.DATABASE_URL ||
      !path.isAbsolute(process.env.DATABASE_URL)) &&
    !fs.existsSync(targetDbPath) &&
    fs.existsSync(oldDbPath);

  if (shouldMigrateDb) {
    try {
      fs.renameSync(oldDbPath, targetDbPath);
      migrated.push(`dev.sqlite → ${path.relative(PROJECT_ROOT, targetDbPath)}`);
      console.log(
        `[paths] 已迁移数据库：${path.relative(PROJECT_ROOT, oldDbPath)} → ${path.relative(PROJECT_ROOT, targetDbPath)}`,
      );

      // 同时迁移 WAL/SHM 临时文件（如果存在）
      for (const suffix of ['-wal', '-shm', '-journal']) {
        const oldSidecar = `${oldDbPath}${suffix}`;
        const newSidecar = `${targetDbPath}${suffix}`;
        if (fs.existsSync(oldSidecar) && !fs.existsSync(newSidecar)) {
          try {
            fs.renameSync(oldSidecar, newSidecar);
          } catch {
            // sidecar 迁移失败不影响主库
          }
        }
      }
    } catch (err) {
      const msg = `数据库迁移失败: ${err instanceof Error ? err.message : String(err)}`;
      warnings.push(msg);
      console.warn(`[paths] ${msg}`);
    }
  }

  // 2. 迁移 uploads/（含 avatars 子目录与用户上传文件）
  const oldUploadsDir = path.join(backendDir, 'uploads');
  const newUploadsDir = UPLOADS_DIR;
  if (
    fs.existsSync(oldUploadsDir) &&
    // 目标目录存在但为空时也允许迁移；非空则视为已有数据，跳过
    (!fs.existsSync(newUploadsDir) ||
      fs.readdirSync(newUploadsDir).length === 0)
  ) {
    try {
      // 跨盘符时 renameSync 会失败，回退到递归复制
      try {
        fs.renameSync(oldUploadsDir, newUploadsDir);
      } catch {
        copyDirSync(oldUploadsDir, newUploadsDir);
        fs.rmSync(oldUploadsDir, { recursive: true, force: true });
      }
      migrated.push(
        `uploads/ → ${path.relative(PROJECT_ROOT, newUploadsDir)}`,
      );
      console.log(
        `[paths] 已迁移上传目录：${path.relative(PROJECT_ROOT, oldUploadsDir)} → ${path.relative(PROJECT_ROOT, newUploadsDir)}`,
      );

      // 重新创建 avatars 子目录（rename 后 newUploadsDir 本身已是 uploads，仅需确保 avatars 存在）
      if (!fs.existsSync(AVATARS_DIR)) {
        fs.mkdirSync(AVATARS_DIR, { recursive: true });
      }
    } catch (err) {
      const msg = `uploads 目录迁移失败: ${err instanceof Error ? err.message : String(err)}`;
      warnings.push(msg);
      console.warn(`[paths] ${msg}`);
    }
  }

  if (migrated.length > 0) {
    console.log(
      `[paths] 旧版数据已迁移至 config/ 目录（共 ${migrated.length} 项）。下次升级只需保留 config/ 目录即可保留全部数据。`,
    );
  }

  return { migrated, warnings };
}

/** 递归复制目录（跨盘符 rename 失败时的回退方案）。 */
function copyDirSync(src: string, dest: string): void {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
