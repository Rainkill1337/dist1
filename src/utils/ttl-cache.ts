/**
 * 通用 TTL + LRU 内存缓存。
 *
 * 特性：
 * - 每条记录按 ttlMs 自动过期，读取时惰性清理；
 * - 容量达到 maxSize 时按 LRU（最久未使用）淘汰；
 * - get 命中会刷新该键的活跃度。
 *
 * 用于替代各业务模块手写的无界 Map 缓存（VIP 状态、用户信息、视频信息等），
 * 避免内存无界增长。
 */

export interface TtlCacheOptions {
  /** 单条记录存活时间（毫秒） */
  ttlMs: number;
  /** 最大记录数，超出后按 LRU 淘汰。默认 500 */
  maxSize?: number;
}

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

const DEFAULT_MAX_SIZE = 500;

export class TtlCache<V> {
  private readonly ttlMs: number;
  private readonly maxSize: number;
  private readonly map = new Map<string, CacheEntry<V>>();

  constructor(options: TtlCacheOptions) {
    this.ttlMs = options.ttlMs;
    this.maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
  }

  get(key: string): V | null {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.map.delete(key);
      return null;
    }
    // LRU：命中后移到 Map 尾部（Map 保持插入顺序）
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    // 先删除已有键，保证插入顺序反映最新写入
    this.map.delete(key);
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    this.evictIfNeeded();
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }

  private evictIfNeeded(): void {
    while (this.map.size > this.maxSize) {
      // Map 迭代顺序即插入顺序，第一个键为最久未使用
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      this.map.delete(oldestKey);
    }
  }
}
