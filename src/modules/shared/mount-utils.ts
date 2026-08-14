/**
 * 挂载路由共享工具函数。
 *
 * 消除 emby.ts / jellyfin.ts / ftp.ts / webdav.ts 中的重复代码。
 */
import { UserMount } from '../../entities/UserMount';

/** 移除挂载对象的密码字段，返回安全的响应对象。 */
export function stripPassword(mount: UserMount): Omit<UserMount, 'password'> {
  const { password: _password, ...rest } = mount;
  return rest;
}

/** 从未知错误对象中提取错误消息。 */
export function extractErrorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}