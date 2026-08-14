/**
 * 语音聊天模块（服务器中转）。
 *
 * 从 services/screen-sharing/signaling.ts 中分离，不再与 WebRTC 信令混在同一文件。
 * 语音聊天使用服务器中转 PCM/Opus 音频数据，非 WebRTC P2P Mesh。
 */
export { VoiceChatHandler } from './voice-chat.handler';
