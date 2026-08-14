/**
 * Jellyfin 客户端服务
 *
 * Jellyfin 是 Emby 的一个开源分支，API 完全兼容。
 * 本文件重导出 EmbyClient 作为 JellyfinClient，保持分离式架构。
 */
export {
  EmbyClient as JellyfinClient,
  EmbyError as JellyfinError,
  createEmbyClientFromMount as createJellyfinClientFromMount,
} from './emby-client';

export type {
  EmbyLoginResult as JellyfinLoginResult,
  EmbyUserInfo as JellyfinUserInfo,
  EmbyItem as JellyfinItem,
  EmbyPlaybackInfo as JellyfinPlaybackInfo,
  EmbyClientOptions as JellyfinClientOptions,
} from './emby-client';