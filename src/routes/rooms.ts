import { Router, Response } from 'express';
import { Server as SocketIOServer } from 'socket.io';
import { AppDataSource } from '../data-source';
import { Movie } from '../entities/Movie';
import { Room } from '../entities/Room';
import { Session } from '../entities/Session';
import { DanmakuTrack } from '../entities/DanmakuTrack';
import { IsNull, In } from 'typeorm';
import {
  authenticateToken,
  AuthenticatedRequest,
} from '../middleware/auth';
import { roomStateService } from '../modules/room/room-state.service';
import {
  danmakuMetaService,
  serializeDanmakuMeta,
} from '../modules/comment/danmaku-meta.service';

const movieRepository = () => AppDataSource.getRepository(Movie);
const roomRepository = () => AppDataSource.getRepository(Room);
const sessionRepository = () => AppDataSource.getRepository(Session);
const danmakuTrackRepository = () => AppDataSource.getRepository(DanmakuTrack);

interface QualityOption {
  id: number;
  label: string;
  resolution?: string;
}

interface PageOption {
  page: number;
  cid: number;
  part: string;
  duration: number;
}

interface MovieDto {
  id: number;
  roomId: string;
  url: string;
  title: string;
  cover: string | null;
  source: string | null;
  audioUrl: string | null;
  format: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  duration: number | null;
  cid: number | null;
  currentQn: number | null;
  acceptQuality: QualityOption[] | null;
  pages: PageOption[] | null;
  currentPage: number | null;
  serverUrl: string | null;
  path: string | null;
  username: string | null;
  directLink: boolean;
  order: number;
  createdAt: string;
  updatedAt: string;
}

function normalizeAcceptQuality(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value.trim() || null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function parseAcceptQuality(value: string | null): QualityOption[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed as QualityOption[];
    return null;
  } catch {
    return null;
  }
}

function normalizePages(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value.trim() || null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function parsePages(value: string | null): PageOption[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed as PageOption[];
    return null;
  } catch {
    return null;
  }
}

function canControlRoom(req: AuthenticatedRequest, room: Room): boolean {
  const role = req.user?.role;
  if (role === 'root') return true;
  if (role === 'admin' && room.ownerUserId === req.user?.userId) return true;
  return false;
}

function serializeMovie(movie: Movie): MovieDto {
  return {
    id: movie.id,
    roomId: movie.roomId,
    url: movie.url,
    title: movie.title,
    cover: movie.cover,
    source: movie.source,
    audioUrl: movie.audioUrl,
    format: movie.format,
    videoCodec: movie.videoCodec,
    audioCodec: movie.audioCodec,
    duration: movie.duration,
    cid: movie.cid,
    currentQn: movie.currentQn,
    acceptQuality: parseAcceptQuality(movie.acceptQuality),
    pages: parsePages(movie.pages),
    currentPage: movie.currentPage,
    serverUrl: movie.serverUrl,
    path: movie.path,
    username: movie.username,
    directLink: movie.directLink,
    order: movie.order,
    createdAt: movie.createdAt.toISOString(),
    updatedAt: movie.updatedAt.toISOString(),
  };
}

/** 弹幕轨道 DTO（与前端 DanmakuTrack 对齐） */
interface DanmakuTrackDto {
  trackId: string;
  label: string;
  source: string;
  items: unknown[];
  offset: number;
  hidden: boolean;
}

function serializeDanmakuTrack(track: DanmakuTrack): DanmakuTrackDto {
  let items: unknown[] = [];
  try {
    items = JSON.parse(track.items);
    if (!Array.isArray(items)) items = [];
  } catch {
    items = [];
  }
  return {
    trackId: track.trackId,
    label: track.label,
    source: track.source,
    items,
    offset: track.offset,
    hidden: track.hidden,
  };
}

async function broadcastDanmakuTracks(
  io: SocketIOServer,
  roomId: string,
): Promise<void> {
  const tracks = await danmakuTrackRepository().find({ where: { roomId } });
  io.to(roomId).emit('danmaku-tracks-updated', {
    roomId,
    tracks: tracks.map(serializeDanmakuTrack),
  });
}

async function broadcastMovieList(
  io: SocketIOServer,
  roomId: string,
): Promise<void> {
  const movies = await movieRepository().find({
    where: { roomId },
    order: { order: 'ASC', id: 'ASC' },
  });

  // 同步数据库影片到新架构 roomStateService（modules/room/room-state.service.ts）
  // 必要性：REST API 添加/删除/重排影片只操作数据库，不会更新 roomStateService。
  // 若不同步，play-movie 事件在 roomStateService.getMovies 中找不到影片，导致
  // currentMovieId 永远不被设置，进而 watch-together-state 保存的
  // playback.currentMovieId 为 undefined，房主刷新后无法恢复播放进度。
  const runtimeMovies = movies.map((m) => ({
    id: m.id,
    roomId,
    sourceType: (m.source || 'mp4') as 'bilibili' | 'mp4' | 'webdav' | 'ftp' | 'openlist' | 'smb',
    title: m.title,
    url: m.url,
    cid: m.cid ?? undefined,
    duration: m.duration ?? undefined,
    audioUrl: m.audioUrl ?? undefined,
    videoCodec: m.videoCodec ?? undefined,
    audioCodec: m.audioCodec ?? undefined,
    format: (m.format as 'dash' | 'mp4') ?? undefined,
  }));
  roomStateService.setMovies(roomId, runtimeMovies);

  // 如果当前播放的影片已不在列表中，清空 currentMovieId
  const currentMovieId = roomStateService.getCurrentMovieId(roomId);
  if (
    currentMovieId != null &&
    !runtimeMovies.some((m) => m.id === currentMovieId)
  ) {
    roomStateService.setCurrentMovie(roomId, null);
  }

  io.to(roomId).emit('movie-list', {
    movies: movies.map(serializeMovie),
  });
}

export function createRoomsRouter(io: SocketIOServer): Router {
  const router = Router();

  router.use(authenticateToken);

  // GET /api/rooms - 获取房间列表
  router.get(
    '/',
    async (_req: AuthenticatedRequest, res: Response) => {
      try {
        const roomRepo = roomRepository();
        const sessionRepo = sessionRepository();
        const rooms = await roomRepo.find({
          where: { status: 'active' },
          order: { lastAccessedAt: 'DESC' },
        });

        // 批量查询观众数和 sharer 在线状态（消除 N+1）
        const roomIds = rooms.map((r) => r.roomId);
        const [allViewers, allSharers] = await Promise.all([
          sessionRepo.find({
            where: { roomId: In(roomIds), role: 'viewer', endedAt: IsNull() },
            select: ['roomId'],
          }),
          sessionRepo.find({
            where: { roomId: In(roomIds), role: 'sharer', endedAt: IsNull() },
            select: ['roomId'],
          }),
        ]);
        const viewerCountMap = new Map<string, number>();
        for (const v of allViewers) {
          viewerCountMap.set(v.roomId, (viewerCountMap.get(v.roomId) || 0) + 1);
        }
        const sharerSet = new Set(allSharers.map((s) => s.roomId));

        const result = rooms.map((room) => ({
              id: room.id,
              roomId: room.roomId,
              name: room.name,
              status: room.status,
              requireApproval: room.requireApproval,
              maxViewers: room.maxViewers,
              hasPassword: !!room.password,
              viewerCount: viewerCountMap.get(room.roomId) ?? 0,
              sharerOnline: sharerSet.has(room.roomId),
              mode: room.mode,
              lastAccessedAt: room.lastAccessedAt.toISOString(),
              createdAt: room.createdAt.toISOString(),
            }));

        res.json({ success: true, rooms: result });
      } catch (err) {
        console.error('get rooms error:', err);
        res.status(500).json({ success: false, message: '获取房间列表失败' });
      }
    },
  );

  // PUT /api/rooms/:roomId/name - 修改房间名称（仅 root 或房间创建者）
  router.put(
    '/:roomId/name',
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const roomId = req.params.roomId as string;
        const { name } = req.body as { name?: unknown };
        const trimmed = typeof name === 'string' ? name.trim() : '';
        if (!trimmed) {
          res.status(400).json({ success: false, message: '房间名称不能为空' });
          return;
        }

        const roomRepo = roomRepository();
        const room = await roomRepo.findOneBy({ roomId });
        if (!room) {
          res.status(404).json({ success: false, message: '房间不存在' });
          return;
        }

        if (!canControlRoom(req, room)) {
          res.status(403).json({ success: false, message: '无权限：仅 root 或房间创建者可修改房间名称' });
          return;
        }

        room.name = trimmed;
        await roomRepo.save(room);

        io.to(roomId).emit('room-name-updated', { roomId, name: trimmed });
        res.json({ success: true, room: { roomId, name: trimmed } });
      } catch (err) {
        console.error('update room name error:', err);
        res.status(500).json({ success: false, message: '修改房间名称失败' });
      }
    },
  );

  // GET /api/rooms/:roomId/movies - 获取影片列表
  router.get(
    '/:roomId/movies',
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const roomId = req.params.roomId as string;
        const movies = await movieRepository().find({
          where: { roomId },
          order: { order: 'ASC', id: 'ASC' },
        });
        res.json({ success: true, movies: movies.map(serializeMovie) });
      } catch (err) {
        console.error('get movies error:', err);
        res.status(500).json({ success: false, message: '获取影片列表失败' });
      }
    },
  );

  // POST /api/rooms/:roomId/movies - 新增影片（仅 root 或房间创建者）
  router.post(
    '/:roomId/movies',
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const roomId = req.params.roomId as string;
        const room = await roomRepository().findOneBy({ roomId });
        if (!room) {
          res.status(404).json({ success: false, message: '房间不存在' });
          return;
        }
        if (!canControlRoom(req, room)) {
          res.status(403).json({ success: false, message: '无权限：仅 root 或房间创建者可新增影片' });
          return;
        }

        const {
          url,
          title,
          cover,
          source,
          audioUrl,
          format,
          videoCodec,
          audioCodec,
          duration,
          cid,
          currentQn,
          acceptQuality,
          pages,
          currentPage,
          serverUrl,
          path,
          username,
          password,
          directLink,
        } = req.body as {
          url?: unknown;
          title?: unknown;
          cover?: unknown;
          source?: unknown;
          audioUrl?: unknown;
          format?: unknown;
          videoCodec?: unknown;
          audioCodec?: unknown;
          duration?: unknown;
          cid?: unknown;
          currentQn?: unknown;
          acceptQuality?: unknown;
          pages?: unknown;
          currentPage?: unknown;
          serverUrl?: unknown;
          path?: unknown;
          username?: unknown;
          password?: unknown;
          directLink?: unknown;
        };

        if (
          typeof url !== 'string' ||
          !url.trim() ||
          typeof title !== 'string' ||
          !title.trim()
        ) {
          res
            .status(400)
            .json({ success: false, message: 'url 和 title 为必填项' });
          return;
        }

        const existing = await movieRepository().find({
          where: { roomId },
          order: { order: 'DESC' },
        });
        const nextOrder = existing.length > 0 ? existing[0].order + 1 : 0;

        const movie = movieRepository().create({
          roomId,
          url: url.trim(),
          title: title.trim(),
          cover: typeof cover === 'string' ? cover : null,
          source: typeof source === 'string' ? source : null,
          audioUrl: typeof audioUrl === 'string' ? audioUrl : null,
          format: typeof format === 'string' ? format : null,
          videoCodec: typeof videoCodec === 'string' ? videoCodec : null,
          audioCodec: typeof audioCodec === 'string' ? audioCodec : null,
          duration:
            typeof duration === 'number' && Number.isFinite(duration)
              ? duration
              : null,
          cid:
            typeof cid === 'number' && Number.isFinite(cid) ? cid : null,
          currentQn:
            typeof currentQn === 'number' && Number.isFinite(currentQn)
              ? currentQn
              : null,
          acceptQuality: normalizeAcceptQuality(acceptQuality),
          pages: normalizePages(pages),
          currentPage:
            typeof currentPage === 'number' && Number.isFinite(currentPage)
              ? currentPage
              : null,
          serverUrl: typeof serverUrl === 'string' ? serverUrl : null,
          path: typeof path === 'string' ? path : null,
          username: typeof username === 'string' ? username : null,
          password: typeof password === 'string' ? password : null,
          directLink: directLink === true,
          order: nextOrder,
        });
        await movieRepository().save(movie);

        await broadcastMovieList(io, roomId);
        res.status(201).json({ success: true, movie: serializeMovie(movie) });
      } catch (err) {
        console.error('create movie error:', err);
        res.status(500).json({ success: false, message: '新增影片失败' });
      }
    },
  );

  // POST /api/rooms/:roomId/movies/reorder - 批量重排序（仅 root 或房间创建者）
  router.post(
    '/:roomId/movies/reorder',
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const roomId = req.params.roomId as string;
        const { orderedIds } = req.body as { orderedIds?: unknown };

        if (!Array.isArray(orderedIds)) {
          res
            .status(400)
            .json({ success: false, message: 'orderedIds 必须是数组' });
          return;
        }

        const room = await roomRepository().findOneBy({ roomId });
        if (!room) {
          res.status(404).json({ success: false, message: '房间不存在' });
          return;
        }
        if (!canControlRoom(req, room)) {
          res.status(403).json({ success: false, message: '无权限：仅 root 或房间创建者可重排序影片' });
          return;
        }

        await AppDataSource.transaction(async (manager) => {
          for (let i = 0; i < orderedIds.length; i++) {
            const id = Number(orderedIds[i]);
            if (!Number.isFinite(id)) continue;
            await manager.update(Movie, { id, roomId }, { order: i });
          }
        });

        await broadcastMovieList(io, roomId);
        res.json({ success: true });
      } catch (err) {
        console.error('reorder movies error:', err);
        res.status(500).json({ success: false, message: '重排序失败' });
      }
    },
  );

  // PUT /api/rooms/:roomId/movies/:movieId - 更新影片（仅 root 或房间创建者）
  router.put(
    '/:roomId/movies/:movieId',
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const roomId = req.params.roomId as string;
        const movieId = Number(req.params.movieId);
        const room = await roomRepository().findOneBy({ roomId });
        if (!room) {
          res.status(404).json({ success: false, message: '房间不存在' });
          return;
        }
        if (!canControlRoom(req, room)) {
          res.status(403).json({ success: false, message: '无权限：仅 root 或房间创建者可更新影片' });
          return;
        }

        const {
          url,
          title,
          cover,
          order,
          audioUrl,
          format,
          videoCodec,
          audioCodec,
          duration,
          cid,
          currentQn,
          acceptQuality,
          pages,
          currentPage,
          serverUrl,
          path,
          username,
          password,
          directLink,
        } = req.body as {
          url?: unknown;
          title?: unknown;
          cover?: unknown;
          order?: unknown;
          audioUrl?: unknown;
          format?: unknown;
          videoCodec?: unknown;
          audioCodec?: unknown;
          duration?: unknown;
          cid?: unknown;
          currentQn?: unknown;
          acceptQuality?: unknown;
          pages?: unknown;
          currentPage?: unknown;
          serverUrl?: unknown;
          path?: unknown;
          username?: unknown;
          password?: unknown;
          directLink?: unknown;
        };

        const movie = await movieRepository().findOneBy({
          id: movieId,
          roomId,
        });
        if (!movie) {
          res.status(404).json({ success: false, message: '影片不存在' });
          return;
        }

        const update: {
          url?: string;
          title?: string;
          cover?: string | null;
          order?: number;
          audioUrl?: string | null;
          format?: string | null;
          videoCodec?: string | null;
          audioCodec?: string | null;
          duration?: number | null;
          cid?: number | null;
          currentQn?: number | null;
          acceptQuality?: string | null;
          pages?: string | null;
          currentPage?: number | null;
          serverUrl?: string | null;
          path?: string | null;
          username?: string | null;
          password?: string | null;
          directLink?: boolean;
        } = {};
        if (typeof url === 'string' && url.trim()) update.url = url.trim();
        if (typeof title === 'string' && title.trim())
          update.title = title.trim();
        if (typeof cover === 'string') update.cover = cover;
        if (typeof order === 'number' && Number.isFinite(order))
          update.order = order;
        if (typeof audioUrl === 'string') update.audioUrl = audioUrl;
        if (typeof format === 'string') update.format = format;
        if (typeof videoCodec === 'string') update.videoCodec = videoCodec;
        if (typeof audioCodec === 'string') update.audioCodec = audioCodec;
        if (typeof duration === 'number' && Number.isFinite(duration))
          update.duration = duration;
        if (typeof cid === 'number' && Number.isFinite(cid))
          update.cid = cid;
        if (typeof currentQn === 'number' && Number.isFinite(currentQn))
          update.currentQn = currentQn;
        if (acceptQuality !== undefined)
          update.acceptQuality = normalizeAcceptQuality(acceptQuality);
        if (pages !== undefined) update.pages = normalizePages(pages);
        if (typeof currentPage === 'number' && Number.isFinite(currentPage))
          update.currentPage = currentPage;
        if (typeof serverUrl === 'string') update.serverUrl = serverUrl;
        if (typeof path === 'string') update.path = path;
        if (typeof username === 'string') update.username = username;
        if (typeof password === 'string') update.password = password;
        if (typeof directLink === 'boolean') update.directLink = directLink;

        await movieRepository().update({ id: movie.id }, update);
        await broadcastMovieList(io, roomId);
        res.json({ success: true });
      } catch (err) {
        console.error('update movie error:', err);
        res.status(500).json({ success: false, message: '更新影片失败' });
      }
    },
  );

  // DELETE /api/rooms/:roomId/movies/:movieId - 删除影片（仅 root 或房间创建者）
  router.delete(
    '/:roomId/movies/:movieId',
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const roomId = req.params.roomId as string;
        const movieId = Number(req.params.movieId);
        const room = await roomRepository().findOneBy({ roomId });
        if (!room) {
          res.status(404).json({ success: false, message: '房间不存在' });
          return;
        }
        if (!canControlRoom(req, room)) {
          res.status(403).json({ success: false, message: '无权限：仅 root 或房间创建者可删除影片' });
          return;
        }

        const movie = await movieRepository().findOneBy({
          id: movieId,
          roomId,
        });
        if (!movie) {
          res.status(404).json({ success: false, message: '影片不存在' });
          return;
        }

        await movieRepository().remove(movie);
        await broadcastMovieList(io, roomId);
        res.json({ success: true });
      } catch (err) {
        console.error('delete movie error:', err);
        res.status(500).json({ success: false, message: '删除影片失败' });
      }
    },
  );

  // GET /api/rooms/:roomId/danmaku-tracks - 获取弹幕轨道列表
  router.get(
    '/:roomId/danmaku-tracks',
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const roomId = req.params.roomId as string;
        const tracks = await danmakuTrackRepository().find({ where: { roomId } });
        res.json({
          success: true,
          tracks: tracks.map(serializeDanmakuTrack),
        });
      } catch (err) {
        console.error('get danmaku tracks error:', err);
        res.status(500).json({ success: false, message: '获取弹幕轨道失败' });
      }
    },
  );

  // POST /api/rooms/:roomId/danmaku-tracks - 添加或替换单个弹幕轨道（仅 root 或房间创建者）
  router.post(
    '/:roomId/danmaku-tracks',
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const roomId = req.params.roomId as string;
        const room = await roomRepository().findOneBy({ roomId });
        if (!room) {
          res.status(404).json({ success: false, message: '房间不存在' });
          return;
        }
        if (!canControlRoom(req, room)) {
          res.status(403).json({ success: false, message: '无权限：仅 root 或房间创建者可添加弹幕轨道' });
          return;
        }

        const { trackId, label, source, items, offset, hidden } = req.body as {
          trackId?: unknown;
          label?: unknown;
          source?: unknown;
          items?: unknown;
          offset?: unknown;
          hidden?: unknown;
        };

        if (
          typeof trackId !== 'string' ||
          !trackId.trim() ||
          typeof label !== 'string' ||
          !label.trim() ||
          typeof source !== 'string' ||
          !source.trim() ||
          !Array.isArray(items)
        ) {
          res.status(400).json({ success: false, message: 'trackId/label/source/items 为必填项' });
          return;
        }

        // upsert：按 (roomId, trackId) 唯一，避免重复调用 setDefaultTrack
        // 等场景导致同一 trackId 累积多条记录。
        let track = await danmakuTrackRepository().findOneBy({
          roomId,
          trackId: trackId.trim(),
        });
        if (track) {
          track.label = label.trim();
          track.source = source.trim();
          track.items = JSON.stringify(items);
          track.offset =
            typeof offset === 'number' && Number.isFinite(offset) ? offset : 0;
          track.hidden = hidden === true;
        } else {
          track = danmakuTrackRepository().create({
            trackId: trackId.trim(),
            roomId,
            label: label.trim(),
            source: source.trim(),
            items: JSON.stringify(items),
            offset:
              typeof offset === 'number' && Number.isFinite(offset) ? offset : 0,
            hidden: hidden === true,
          });
        }
        await danmakuTrackRepository().save(track);
        await broadcastDanmakuTracks(io, roomId);
        res.status(201).json({ success: true, track: serializeDanmakuTrack(track) });
      } catch (err) {
        console.error('create danmaku track error:', err);
        res.status(500).json({ success: false, message: '添加弹幕轨道失败' });
      }
    },
  );

  // PUT /api/rooms/:roomId/danmaku-tracks/:trackId/offset - 修改弹幕轨道偏移（仅 root 或房间创建者）
  router.put(
    '/:roomId/danmaku-tracks/:trackId/offset',
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const roomId = req.params.roomId as string;
        const trackId = req.params.trackId as string;
        const room = await roomRepository().findOneBy({ roomId });
        if (!room) {
          res.status(404).json({ success: false, message: '房间不存在' });
          return;
        }
        if (!canControlRoom(req, room)) {
          res.status(403).json({ success: false, message: '无权限：仅 root 或房间创建者可修改弹幕轨道' });
          return;
        }

        const { offset, hidden } = req.body as { offset?: unknown; hidden?: unknown };
        const track = await danmakuTrackRepository().findOneBy({ roomId, trackId });
        if (!track) {
          res.status(404).json({ success: false, message: '弹幕轨道不存在' });
          return;
        }

        if (typeof offset === 'number' && Number.isFinite(offset)) {
          track.offset = offset;
        }
        if (typeof hidden === 'boolean') {
          track.hidden = hidden;
        }
        await danmakuTrackRepository().save(track);
        await broadcastDanmakuTracks(io, roomId);
        res.json({ success: true, track: serializeDanmakuTrack(track) });
      } catch (err) {
        console.error('update danmaku track offset error:', err);
        res.status(500).json({ success: false, message: '修改弹幕轨道失败' });
      }
    },
  );

  // DELETE /api/rooms/:roomId/danmaku-tracks/:trackId - 删除弹幕轨道（仅 root 或房间创建者）
  router.delete(
    '/:roomId/danmaku-tracks/:trackId',
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const roomId = req.params.roomId as string;
        const trackId = req.params.trackId as string;
        const room = await roomRepository().findOneBy({ roomId });
        if (!room) {
          res.status(404).json({ success: false, message: '房间不存在' });
          return;
        }
        if (!canControlRoom(req, room)) {
          res.status(403).json({ success: false, message: '无权限：仅 root 或房间创建者可删除弹幕轨道' });
          return;
        }

        // 批量删除所有匹配 (roomId, trackId) 的记录，
        // 避免历史累积的重复 trackId 残留。
        await danmakuTrackRepository().delete({ roomId, trackId });
        await broadcastDanmakuTracks(io, roomId);
        res.json({ success: true });
      } catch (err) {
        console.error('delete danmaku track error:', err);
        res.status(500).json({ success: false, message: '删除弹幕轨道失败' });
      }
    },
  );

  // POST /api/rooms/:roomId/danmaku-tracks/bulk - 批量替换弹幕轨道（仅 root 或房间创建者）
  router.post(
    '/:roomId/danmaku-tracks/bulk',
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const roomId = req.params.roomId as string;
        const room = await roomRepository().findOneBy({ roomId });
        if (!room) {
          res.status(404).json({ success: false, message: '房间不存在' });
          return;
        }
        if (!canControlRoom(req, room)) {
          res.status(403).json({ success: false, message: '无权限：仅 root 或房间创建者可修改弹幕轨道' });
          return;
        }

        const { tracks } = req.body as { tracks?: unknown };
        if (!Array.isArray(tracks)) {
          res.status(400).json({ success: false, message: 'tracks 必须是数组' });
          return;
        }

        await AppDataSource.transaction(async (manager) => {
          await manager.delete(DanmakuTrack, { roomId });
          for (const t of tracks) {
            const raw = t as Record<string, unknown>;
            if (
              typeof raw.trackId !== 'string' ||
              !raw.trackId.trim() ||
              typeof raw.label !== 'string' ||
              !raw.label.trim() ||
              typeof raw.source !== 'string' ||
              !raw.source.trim() ||
              !Array.isArray(raw.items)
            ) {
              continue;
            }
            const entity = manager.create(DanmakuTrack, {
              trackId: raw.trackId.trim(),
              roomId,
              label: raw.label.trim(),
              source: raw.source.trim(),
              items: JSON.stringify(raw.items),
              offset:
                typeof raw.offset === 'number' && Number.isFinite(raw.offset)
                  ? raw.offset
                  : 0,
              hidden: raw.hidden === true,
            });
            await manager.save(entity);
          }
        });

        await broadcastDanmakuTracks(io, roomId);
        const saved = await danmakuTrackRepository().find({ where: { roomId } });
        res.json({ success: true, tracks: saved.map(serializeDanmakuTrack) });
      } catch (err) {
        console.error('bulk replace danmaku tracks error:', err);
        res.status(500).json({ success: false, message: '批量替换弹幕轨道失败' });
      }
    },
  );

  // GET /api/rooms/:roomId/danmaku-meta - 获取房间弹幕辅助数据（屏蔽词/已删除/实时弹幕记录）
  router.get(
    '/:roomId/danmaku-meta',
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const roomId = req.params.roomId as string;
        const meta = await danmakuMetaService.getOrCreate(roomId);
        res.json({ success: true, meta: serializeDanmakuMeta(meta) });
      } catch (err) {
        console.error('get danmaku meta error:', err);
        res.status(500).json({ success: false, message: '获取弹幕辅助数据失败' });
      }
    },
  );

  // PUT /api/rooms/:roomId/danmaku-meta - 整体替换屏蔽词和已删除弹幕（仅 root 或房间创建者）
  // 注意：realtimeLog 由 send-danmaku 事件持久化，此接口不修改 realtimeLog
  router.put(
    '/:roomId/danmaku-meta',
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const roomId = req.params.roomId as string;
        const room = await roomRepository().findOneBy({ roomId });
        if (!room) {
          res.status(404).json({ success: false, message: '房间不存在' });
          return;
        }
        if (!canControlRoom(req, room)) {
          res.status(403).json({ success: false, message: '无权限：仅 root 或房间创建者可修改弹幕辅助数据' });
          return;
        }

        const { blockKeywords, deletedLog } = req.body as {
          blockKeywords?: unknown;
          deletedLog?: unknown;
        };

        // 未提供的字段从已有记录读取，保持原值
        const existing = await danmakuMetaService.getOrCreate(roomId);
        const existingDto = serializeDanmakuMeta(existing);
        const nextKeywords = Array.isArray(blockKeywords)
          ? blockKeywords.filter(
              (k): k is string => typeof k === 'string' && k.trim().length > 0,
            )
          : existingDto.blockKeywords;
        const nextDeleted = Array.isArray(deletedLog) ? deletedLog : existingDto.deletedLog;

        const meta = await danmakuMetaService.replaceBlockAndDeleted(
          roomId,
          nextKeywords,
          nextDeleted,
        );
        await danmakuMetaService.broadcast(io, roomId);
        res.json({ success: true, meta: serializeDanmakuMeta(meta) });
      } catch (err) {
        console.error('update danmaku meta error:', err);
        res.status(500).json({ success: false, message: '更新弹幕辅助数据失败' });
      }
    },
  );

  return router;
}
