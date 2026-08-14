/**
 * WebRTC 信令模块。
 *
 * 分离式架构：
 * - signaling.handler.ts — WebRTC 信令转发（offer/answer/ICE candidate）
 * - viewer-events.handler.ts — 观众就绪事件（viewer-ready / sharer-ready）
 *
 * 迁移自 services/screen-sharing/，改造为 SocketEventHandler 接口，
 * 由 SocketRegistry 统一注册，消除旧架构的 io.on('connection') 自管理风格。
 *
 * 语音聊天已分离到 modules/voice-chat/，不再混入本模块。
 */
export { SignalingHandler } from './signaling.handler';
export { ViewerEventsHandler } from './viewer-events.handler';
