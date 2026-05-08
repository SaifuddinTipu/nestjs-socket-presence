import { ModuleMetadata, Type } from '@nestjs/common';

export interface PresenceModuleOptions {
  /**
   * ioredis connection options OR an existing ioredis instance token to inject.
   * If omitted, the module expects an existing Redis connection in the DI container.
   */
  redis: RedisConfig;

  /**
   * TTL in seconds for the presence key in Redis.
   * After this many seconds without a heartbeat the user is considered offline.
   * Default: 30
   */
  ttl?: number;

  /**
   * Redis key prefix. Default: 'presence'
   */
  keyPrefix?: string;
}

export interface RedisConfig {
  host?: string;
  port?: number;
  password?: string;
  db?: number;
  url?: string;
}

export interface PresenceModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  useFactory: (...args: unknown[]) => Promise<PresenceModuleOptions> | PresenceModuleOptions;
  inject?: (string | symbol | Type<unknown>)[];
}

export interface UserPresence {
  userId: string;
  online: boolean;
  socketIds: string[];
  lastSeen: number;
  metadata?: Record<string, unknown>;
}

export interface RoomPresence {
  room: string;
  users: UserPresence[];
  onlineCount: number;
}
