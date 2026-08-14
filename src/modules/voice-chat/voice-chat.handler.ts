/**
 * 语音聊天处理器（服务器中转）。
 *
 * 职责：管理房间内语音聊天成员状态，中转 PCM/Opus 音频数据。
 *
 * 设计：
 * - 实现 SocketEventHandler 接口，由 SocketRegistry 统一注册
 * - 从 services/screen-sharing/signaling.ts 中分离，消除信令与语音聊天的耦合
 * - 成员状态使用内存 Map 管理，断连时自动清理
 */
import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { SocketEventHandler } from '../socket';

/** 每个房间当前处于语音聊天中的 socket id 集合 */
const voiceMembers = new Map<string, Set<string>>();

/**
 * 校验 socket 是否已加入指定房间。
 */
function isSocketInRoom(socket: Socket, roomId: string): boolean {
  return socket.rooms.has(roomId);
}

/**
 * 从房间的语音成员集合中移除指定 socket，并向房间内其他成员广播离开事件。
 */
function leaveVoiceChat(io: SocketIOServer, socket: Socket, roomId: string): void {
  const members = voiceMembers.get(roomId);
  if (!members) return;
  if (!members.has(socket.id)) return;

  members.delete(socket.id);
  socket.to(roomId).emit('voice-user-left', { socketId: socket.id });
  console.log(`[voice] ${socket.id} left room ${roomId}`);

  if (members.size === 0) {
    voiceMembers.delete(roomId);
  }
}

export class VoiceChatHandler implements SocketEventHandler {
  readonly name = 'voice-chat';

  register(socket: Socket, io: SocketIOServer): void {
    // --- 加入语音聊天 ---
    socket.on(
      'voice-join',
      (
        payload: { roomId: string },
        callback?: (
          response:
            | { success: true; members: string[] }
            | { success: false; message: string },
        ) => void,
      ) => {
        const { roomId } = payload;
        if (!isSocketInRoom(socket, roomId)) {
          return callback?.({ success: false, message: '不在该房间中' });
        }

        let members = voiceMembers.get(roomId);
        if (!members) {
          members = new Set();
          voiceMembers.set(roomId, members);
        }

        if (members.has(socket.id)) {
          return callback?.({
            success: true,
            members: Array.from(members).filter((id) => id !== socket.id),
          });
        }

        members.add(socket.id);
        socket.to(roomId).emit('voice-user-joined', { socketId: socket.id });
        console.log(`[voice] ${socket.id} joined room ${roomId}`);

        callback?.({
          success: true,
          members: Array.from(members).filter((id) => id !== socket.id),
        });
      },
    );

    // --- 离开语音聊天 ---
    socket.on(
      'voice-leave',
      (
        payload: { roomId: string },
        callback?: (response: { success: boolean }) => void,
      ) => {
        leaveVoiceChat(io, socket, payload.roomId);
        callback?.({ success: true });
      },
    );

    // --- 语音音频数据中转 ---
    socket.on('voice-audio-data', (payload: {
      roomId: string;
      data: ArrayBuffer;
      sampleRate?: number;
      timestamp: number;
      mediaTs?: number;
      encoded?: boolean;
    }) => {
      try {
        const members = voiceMembers.get(payload.roomId);
        if (!members || !members.has(socket.id)) return;

        socket.to(payload.roomId).emit('voice-audio-data', {
          from: socket.id,
          data: payload.data,
          sampleRate: payload.sampleRate,
          timestamp: payload.timestamp,
          mediaTs: payload.mediaTs,
          encoded: payload.encoded,
        });
      } catch (err) {
        console.error('[voice-audio-data] error:', err);
      }
    });

    // --- 语音编解码器配置转发 ---
    socket.on('voice-codec-config', (payload: { roomId: string; description: ArrayBuffer }) => {
      try {
        const members = voiceMembers.get(payload.roomId);
        if (!members || !members.has(socket.id)) return;

        socket.to(payload.roomId).emit('voice-codec-config', {
          from: socket.id,
          description: payload.description,
        });
      } catch (err) {
        console.error('[voice-codec-config] error:', err);
      }
    });

    // --- 断开连接时自动清理语音聊天状态 ---
    socket.on('disconnect', () => {
      for (const roomId of Array.from(socket.rooms)) {
        if (roomId === socket.id) continue;
        leaveVoiceChat(io, socket, roomId);
      }
    });
  }
}
