/**
 * 影片流统一凭证解析
 *
 * 将各挂载源 /stream 端点重复的"读取 Movie + 按 serverUrl 补凭证"逻辑收敛于此，
 * 保证 webdav / ftp / emby / jellyfin 的影片流代理行为一致：
 * - Movie 不存在 / 未挂载服务器信息 → 统一错误
 * - 旧影片可能未存储 username/password，从 UserMount 表按 serverUrl + source 补全
 * - 同时返回挂载记录（ftp 需要 port，emby/jellyfin 需要建 session）
 */
import { AppDataSource } from '../../data-source';
import { Movie } from '../../entities/Movie';
import { UserMount } from '../../entities/UserMount';
import type { MountType } from '../../services/proxy/mount-proxy';

export class StreamMovieError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'StreamMovieError';
  }
}

export interface ResolvedMovieStream {
  movie: Movie;
  /** 凭证回退后的凭据（webdav/ftp 流使用） */
  username?: string;
  password?: string;
  /** 按 serverUrl + source 查到的挂载（ftp 补 port，emby/jellyfin 建 session） */
  mount?: UserMount;
}

/**
 * 解析影片流所需的 Movie 与凭证。
 * @param movieId 影片 ID
 * @param source  挂载源类型（webdav/ftp/emby/jellyfin）
 */
export async function resolveMovieStream(
  movieId: number,
  source: MountType,
): Promise<ResolvedMovieStream> {
  const movie = await AppDataSource.getRepository(Movie).findOneBy({ id: movieId });
  if (!movie) {
    throw new StreamMovieError('影片不存在', 'NOT_FOUND', 404);
  }
  if (!movie.serverUrl || !movie.path) {
    throw new StreamMovieError('该影片未挂载服务器信息', 'NO_SERVER', 400);
  }

  let username = movie.username || undefined;
  let password = movie.password || undefined;
  const mount = await AppDataSource.getRepository(UserMount).findOneBy({
    serverUrl: movie.serverUrl,
    type: source,
  });
  if (mount) {
    username = username || mount.username || undefined;
    password = password || mount.password || undefined;
  }

  return { movie, username, password, mount: mount ?? undefined };
}
