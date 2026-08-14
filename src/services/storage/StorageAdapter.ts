/**
 * 存储适配器接口（#16 Redis 多实例支持）。
 *
 * 封装运行时状态的存储，支持内存与 Redis 两种实现。
 * 接口为同步，Redis 适配器使用本地缓存 + 写穿透模式：
 * - 读：从本地缓存返回（同步、快速）
 * - 写：同步更新本地缓存 + 异步写 Redis（fire-and-forget）
 * - 启动：调用 init() 从 Redis 加载全量数据到本地缓存
 *
 * 当前默认使用 MemoryStorageAdapter，行为与之前完全一致。
 * 启用 Redis 时创建 RedisStorageAdapter 实例并注入到对应服务。
 */
export interface StorageAdapter<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  delete(key: string): void;
  has(key: string): boolean;
  keys(): IterableIterator<string>;
  entries(): IterableIterator<[string, T]>;
  clear(): void;
  get size(): number;
  /** 启动时从后端存储加载全量数据到本地缓存（Redis 适配器实现） */
  init?(): Promise<void>;
}

/**
 * 内存存储适配器：基于 Map 实现，为当前默认行为。
 */
export class MemoryStorageAdapter<T> implements StorageAdapter<T> {
  private readonly store = new Map<string, T>();

  get(key: string): T | undefined {
    return this.store.get(key);
  }

  set(key: string, value: T): void {
    this.store.set(key, value);
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  keys(): IterableIterator<string> {
    return this.store.keys();
  }

  entries(): IterableIterator<[string, T]> {
    return this.store.entries();
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}

/**
 * Redis 存储适配器（可选，需安装 ioredis）。
 *
 * 使用本地缓存 + 写穿透模式：
 * - 所有读写操作同步（从本地缓存），业务代码无需 await
 * - set/delete 写操作同步更新本地缓存，同时异步写 Redis
 * - 启动时调用 init() 从 Redis 加载全量数据到本地缓存
 *
 * 使用方式：
 * ```ts
 * import Redis from 'ioredis';
 * const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
 * roomStateService.setStorageAdapter(
 *   new RedisStorageAdapter<RoomRuntimeState>(redis, 'room:state')
 * );
 * ```
 */
export class RedisStorageAdapter<T> implements StorageAdapter<T> {
  private readonly localCache = new Map<string, T>();

  constructor(
    private readonly redis: {
      get(key: string): Promise<string | null>;
      set(key: string, value: string): Promise<unknown>;
      del(...keys: string[]): Promise<number>;
      exists(key: string): Promise<number>;
      scan(cursor: string, opts: { match: string; count: number }): Promise<[string, string[]]>;
      mget(...keys: string[]): Promise<(string | null)[]>;
    },
    private readonly prefix: string,
  ) {}

  private prefixed(key: string): string {
    return `${this.prefix}:${key}`;
  }

  get(key: string): T | undefined {
    return this.localCache.get(key);
  }

  set(key: string, value: T): void {
    this.localCache.set(key, value);
    // 写穿透：异步写 Redis，fire-and-forget
    this.redis.set(this.prefixed(key), JSON.stringify(value)).catch(() => {
      // 写失败不阻塞主流程
    });
  }

  delete(key: string): void {
    this.localCache.delete(key);
    this.redis.del(this.prefixed(key)).catch(() => {});
  }

  has(key: string): boolean {
    return this.localCache.has(key);
  }

  keys(): IterableIterator<string> {
    return this.localCache.keys();
  }

  entries(): IterableIterator<[string, T]> {
    return this.localCache.entries();
  }

  clear(): void {
    this.localCache.clear();
    // 异步清除 Redis
    this.clearRedis().catch(() => {});
  }

  /** 完整遍历 SCAN 分页，返回所有 key 的原始值（含前缀）。 */
  private async scanAllKeys(): Promise<string[]> {
    const allKeys: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, batch] = await this.redis.scan(cursor, {
        match: `${this.prefix}:*`,
        count: 1000,
      });
      allKeys.push(...batch);
      cursor = nextCursor;
    } while (cursor !== '0');
    return allKeys;
  }

  private async clearRedis(): Promise<void> {
    const keys = await this.scanAllKeys();
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }

  get size(): number {
    return this.localCache.size;
  }

  /** 启动时从 Redis 加载全量数据到本地缓存。 */
  async init(): Promise<void> {
    const keys = await this.scanAllKeys();
    if (keys.length === 0) return;
    const values = await this.redis.mget(...keys);
    for (let i = 0; i < keys.length; i++) {
      const raw = values[i];
      if (raw !== null) {
        const roomId = keys[i].slice(this.prefix.length + 1);
        try {
          this.localCache.set(roomId, JSON.parse(raw) as T);
        } catch {
          // skip parse errors
        }
      }
    }
  }
}