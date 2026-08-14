/**
 * 存储模块公共 API（#16 Redis 多实例支持）。
 *
 * 封装运行时状态的后端存储，支持内存与 Redis 两种实现。
 *
 * 当前默认使用 MemoryStorageAdapter，行为与之前完全一致。
 * 如需启用 Redis：
 * 1. `npm install ioredis`
 * 2. `import Redis from 'ioredis'`
 * 3. 创建 `RedisStorageAdapter` 实例并注入到 `roomStateService` / `playbackMemoryService`
 *
 * ```ts
 * import Redis from 'ioredis';
 * import { RedisStorageAdapter } from './services/storage';
 * const redis = new Redis(process.env.REDIS_URL);
 * roomStateService.setStorageAdapter(
 *   new RedisStorageAdapter(redis, 'room:state')
 * );
 * ```
 */
export { MemoryStorageAdapter, RedisStorageAdapter } from './StorageAdapter';
export type { StorageAdapter } from './StorageAdapter';