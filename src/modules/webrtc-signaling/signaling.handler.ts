/**
 * WebRTC 信令转发处理器。
 *
 * 职责：转发 signal-offer / signal-answer / signal-ice-candidate 事件，
 * 校验双方处于同一房间后中继给目标 socket。
 *
 * 设计：实现 SocketEventHandler 接口，由 SocketRegistry 统一注册。
 * 迁移自 services/screen-sharing/signaling.ts（仅 WebRTC 信令部分，
 * 语音聊天已分离到 modules/voice-chat/）。
 */
import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { SocketEventHandler } from '../socket';

/**
 * 校验双方是否处于同一房间，返回共同房间 ID。
 */
async function validateSignalPair(
  io: SocketIOServer,
  fromSocket: Socket,
  toSocketId: string,
): Promise<string | null> {
  const toSocket = io.sockets.sockets.get(toSocketId);
  if (!toSocket) return null;

  const fromRooms = new Set(fromSocket.rooms);
  for (const room of toSocket.rooms) {
    if (room !== toSocket.id && fromRooms.has(room)) {
      return room;
    }
  }
  return null;
}

function safeCallback(callback?: (response: { success: boolean; message?: string }) => void, result?: { success: boolean; message?: string }): void {
  try {
    callback?.(result ?? { success: true });
  } catch {
    // callback 抛异常不影响主流程
  }
}

export class SignalingHandler implements SocketEventHandler {
  readonly name = 'webrtc-signaling';

  register(socket: Socket, io: SocketIOServer): void {
    // --- 转发 offer ---
    socket.on(
      'signal-offer',
      async (
        payload: { to: string; data: unknown },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          const roomId = await validateSignalPair(io, socket, payload.to);
          if (!roomId) {
            console.warn(
              `[signal-offer] pair validation failed from=${socket.id} to=${payload.to}`,
            );
            safeCallback(callback, { success: false, message: '不在同一房间' });
            return;
          }
          console.log(
            `[signal-offer] relay from=${socket.id} to=${payload.to} room=${roomId}`,
          );
          io.to(payload.to).emit('signal-offer', {
            from: socket.id,
            data: payload.data,
          });
          safeCallback(callback);
        } catch (err) {
          console.error('[signal-offer] error:', err);
          safeCallback(callback, { success: false, message: '信令转发失败' });
        }
      },
    );

    // --- 转发 answer ---
    socket.on(
      'signal-answer',
      async (
        payload: { to: string; data: unknown },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          const roomId = await validateSignalPair(io, socket, payload.to);
          if (!roomId) {
            console.warn(
              `[signal-answer] pair validation failed from=${socket.id} to=${payload.to}`,
            );
            safeCallback(callback, { success: false, message: '不在同一房间' });
            return;
          }
          console.log(
            `[signal-answer] relay from=${socket.id} to=${payload.to} room=${roomId}`,
          );
          io.to(payload.to).emit('signal-answer', {
            from: socket.id,
            data: payload.data,
          });
          safeCallback(callback);
        } catch (err) {
          console.error('[signal-answer] error:', err);
          safeCallback(callback, { success: false, message: '信令转发失败' });
        }
      },
    );

    // --- 转发 ICE candidate ---
    socket.on(
      'signal-ice-candidate',
      async (
        payload: { to: string; data: unknown },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          const roomId = await validateSignalPair(io, socket, payload.to);
          if (!roomId) {
            console.warn(
              `[signal-ice-candidate] pair validation failed from=${socket.id} to=${payload.to}`,
            );
            safeCallback(callback, { success: false, message: '不在同一房间' });
            return;
          }
          io.to(payload.to).emit('signal-ice-candidate', {
            from: socket.id,
            data: payload.data,
          });
          safeCallback(callback);
        } catch (err) {
          console.error('[signal-ice-candidate] error:', err);
          safeCallback(callback, { success: false, message: '信令转发失败' });
        }
      },
    );
  }
}