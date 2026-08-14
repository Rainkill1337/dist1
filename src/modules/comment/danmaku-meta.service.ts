/**
 * 房间弹幕辅助数据服务。
 *
 * 封装 RoomDanmakuMeta 实体的读写操作，供 routes/rooms.ts 和
 * comment.handler.ts 共享，避免在多处直接操作仓库。
 *
 * 设计目的：
 * - 提供 getOrCreate：保证房间一定有一条 meta 记录
 * - 提供 appendRealtime：send-danmaku 事件追加实时弹幕记录（限 500 条）
 * - 提供 replaceBlockAndDeleted：整体替换屏蔽词和已删除弹幕
 */
import type { Server as SocketIOServer } from 'socket.io';
import { AppDataSource } from '../../data-source';
import { RoomDanmakuMeta } from '../../entities/RoomDanmakuMeta';

/** 实时弹幕记录上限（超出后丢弃最旧的） */
const REALTIME_LOG_LIMIT = 500;

export interface RealtimeDanmakuEntryDto {
  id: string;
  content: string;
  sender?: string;
  /** 发送时的播放进度（秒） */
  time?: number;
}

export interface DanmakuMetaDto {
  blockKeywords: string[];
  deletedLog: unknown[];
  realtimeLog: unknown[];
}

function parseJsonArray(value: string | null | undefined): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function serializeDanmakuMeta(meta: RoomDanmakuMeta): DanmakuMetaDto {
  return {
    blockKeywords: parseJsonArray(meta.blockKeywords) as string[],
    deletedLog: parseJsonArray(meta.deletedLog),
    realtimeLog: parseJsonArray(meta.realtimeLog),
  };
}

class DanmakuMetaService {
  /**
   * 获取房间的弹幕辅助数据，不存在则创建空记录。
   */
  async getOrCreate(roomId: string): Promise<RoomDanmakuMeta> {
    const repo = AppDataSource.getRepository(RoomDanmakuMeta);
    const existing = await repo.findOneBy({ roomId });
    if (existing) return existing;
    const created = repo.create({
      roomId,
      blockKeywords: '[]',
      deletedLog: '[]',
      realtimeLog: '[]',
    });
    await repo.save(created);
    return created;
  }

  /**
   * 整体替换屏蔽关键词和已删除弹幕记录。
   * realtimeLog 不受此方法影响（由 send-danmaku 事件维护）。
   */
  async replaceBlockAndDeleted(
    roomId: string,
    blockKeywords: string[],
    deletedLog: unknown[],
  ): Promise<RoomDanmakuMeta> {
    const meta = await this.getOrCreate(roomId);
    meta.blockKeywords = JSON.stringify(blockKeywords);
    meta.deletedLog = JSON.stringify(deletedLog);
    await AppDataSource.getRepository(RoomDanmakuMeta).save(meta);
    return meta;
  }

  /**
   * 追加实时弹幕记录，超过上限丢弃最旧的。
   */
  async appendRealtime(
    roomId: string,
    entry: RealtimeDanmakuEntryDto,
  ): Promise<RoomDanmakuMeta> {
    const meta = await this.getOrCreate(roomId);
    const list = parseJsonArray(meta.realtimeLog) as RealtimeDanmakuEntryDto[];
    list.push(entry);
    if (list.length > REALTIME_LOG_LIMIT) {
      list.splice(0, list.length - REALTIME_LOG_LIMIT);
    }
    meta.realtimeLog = JSON.stringify(list);
    await AppDataSource.getRepository(RoomDanmakuMeta).save(meta);
    return meta;
  }

  /**
   * 广播弹幕辅助数据更新事件给房间内所有成员。
   */
  async broadcast(io: SocketIOServer, roomId: string): Promise<void> {
    const meta = await this.getOrCreate(roomId);
    io.to(roomId).emit('danmaku-meta-updated', {
      roomId,
      meta: serializeDanmakuMeta(meta),
    });
  }
}

export const danmakuMetaService = new DanmakuMetaService();
