import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import {
  DEFAULT_KEY_PREFIX,
  DEFAULT_TTL,
  PRESENCE_MODULE_OPTIONS,
  PRESENCE_REDIS_CLIENT,
} from './presence.constants';
import { PresenceModuleOptions, RoomPresence, UserPresence } from './presence.interfaces';

@Injectable()
export class PresenceService implements OnModuleDestroy {
  private readonly logger = new Logger(PresenceService.name);
  private readonly ttl: number;
  private readonly keyPrefix: string;

  constructor(
    @Inject(PRESENCE_REDIS_CLIENT) private readonly redis: Redis,
    @Inject(PRESENCE_MODULE_OPTIONS) private readonly options: PresenceModuleOptions,
  ) {
    this.ttl = options.ttl ?? DEFAULT_TTL;
    this.keyPrefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
  }

  // ─── Key helpers ────────────────────────────────────────────────────────────

  private userKey(userId: string): string {
    return `${this.keyPrefix}:user:${userId}`;
  }

  private socketKey(socketId: string): string {
    return `${this.keyPrefix}:socket:${socketId}`;
  }

  private roomKey(room: string): string {
    return `${this.keyPrefix}:room:${room}`;
  }

  // ─── Core presence operations ────────────────────────────────────────────────

  /**
   * Mark a user as online, associating their socketId.
   * Idempotent — calling multiple times with different sockets accumulates sockets.
   */
  async setOnline(
    userId: string,
    socketId: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const pipeline = this.redis.pipeline();
    const userKey = this.userKey(userId);
    const socketKey = this.socketKey(socketId);

    // Store socket → userId mapping (for disconnect cleanup)
    pipeline.set(socketKey, userId, 'EX', this.ttl * 2);

    // Add socketId to the user's socket set
    pipeline.sadd(`${userKey}:sockets`, socketId);
    pipeline.expire(`${userKey}:sockets`, this.ttl * 2);

    // Store user presence hash
    const presenceData: Record<string, string> = {
      userId,
      online: '1',
      lastSeen: Date.now().toString(),
    };
    if (metadata) {
      presenceData.metadata = JSON.stringify(metadata);
    }
    pipeline.hmset(userKey, presenceData);
    pipeline.expire(userKey, this.ttl * 2);

    await pipeline.exec();
    this.logger.debug(`User ${userId} online via socket ${socketId}`);
  }

  /**
   * Remove a specific socket from a user. If no sockets remain, marks user offline.
   * Returns true if user went fully offline.
   */
  async removeSocket(socketId: string): Promise<{ userId: string | null; wentOffline: boolean }> {
    const socketKey = this.socketKey(socketId);
    const userId = await this.redis.get(socketKey);

    if (!userId) {
      return { userId: null, wentOffline: false };
    }

    const userKey = this.userKey(userId);
    const pipeline = this.redis.pipeline();
    pipeline.del(socketKey);
    pipeline.srem(`${userKey}:sockets`, socketId);
    const results = await pipeline.exec();

    // results[1] is the SREM result — get remaining socket count
    const remaining = await this.redis.scard(`${userKey}:sockets`);

    if (remaining === 0) {
      await this.setOffline(userId);
      return { userId, wentOffline: true };
    }

    // Update lastSeen even if still connected via other sockets
    await this.redis.hset(userKey, 'lastSeen', Date.now().toString());
    return { userId, wentOffline: false };
  }

  /**
   * Explicitly mark a user as offline and clean up all their presence data.
   */
  async setOffline(userId: string): Promise<void> {
    const userKey = this.userKey(userId);
    const socketsKey = `${userKey}:sockets`;

    // Clean up all socket mappings for this user
    const sockets = await this.redis.smembers(socketsKey);
    if (sockets.length > 0) {
      const pipeline = this.redis.pipeline();
      for (const sid of sockets) {
        pipeline.del(this.socketKey(sid));
      }
      await pipeline.exec();
    }

    const pipeline = this.redis.pipeline();
    pipeline.hset(userKey, 'online', '0', 'lastSeen', Date.now().toString());
    pipeline.expire(userKey, this.ttl * 2);
    pipeline.del(socketsKey);
    await pipeline.exec();

    this.logger.debug(`User ${userId} offline`);
  }

  /**
   * Refresh TTL for a user (heartbeat). Call this periodically from the client.
   */
  async heartbeat(userId: string, socketId: string): Promise<void> {
    const pipeline = this.redis.pipeline();
    pipeline.expire(this.userKey(userId), this.ttl * 2);
    pipeline.expire(`${this.userKey(userId)}:sockets`, this.ttl * 2);
    pipeline.expire(this.socketKey(socketId), this.ttl * 2);
    pipeline.hset(this.userKey(userId), 'lastSeen', Date.now().toString());
    await pipeline.exec();
  }

  // ─── Query operations ────────────────────────────────────────────────────────

  /**
   * Check if a specific user is currently online.
   */
  async isOnline(userId: string): Promise<boolean> {
    const val = await this.redis.hget(this.userKey(userId), 'online');
    return val === '1';
  }

  /**
   * Get full presence info for a user.
   */
  async getUserPresence(userId: string): Promise<UserPresence | null> {
    const userKey = this.userKey(userId);
    const [data, sockets] = await Promise.all([
      this.redis.hgetall(userKey),
      this.redis.smembers(`${userKey}:sockets`),
    ]);

    if (!data || !data.userId) return null;

    return {
      userId: data.userId,
      online: data.online === '1',
      socketIds: sockets,
      lastSeen: parseInt(data.lastSeen ?? '0', 10),
      metadata: data.metadata ? JSON.parse(data.metadata) : undefined,
    };
  }

  /**
   * Bulk check — returns a map of userId → online status.
   */
  async getBulkPresence(userIds: string[]): Promise<Map<string, boolean>> {
    if (userIds.length === 0) return new Map();

    const results = await Promise.all(
      userIds.map((uid) => this.redis.hget(this.userKey(uid), 'online')),
    );

    const map = new Map<string, boolean>();
    userIds.forEach((uid, i) => {
      map.set(uid, results[i] === '1');
    });
    return map;
  }

  /**
   * Get all online users in a room (requires joinRoom/leaveRoom to be used).
   */
  async getRoomPresence(room: string): Promise<RoomPresence> {
    const roomKey = this.roomKey(room);
    const userIds = await this.redis.smembers(roomKey);

    const presences = await Promise.all(
      userIds.map((uid) => this.getUserPresence(uid)),
    );

    const users = presences.filter(
      (p): p is UserPresence => p !== null && p.online,
    );

    return {
      room,
      users,
      onlineCount: users.length,
    };
  }

  /**
   * Track that a user joined a named room.
   */
  async joinRoom(room: string, userId: string): Promise<void> {
    const roomKey = this.roomKey(room);
    await this.redis.sadd(roomKey, userId);
  }

  /**
   * Track that a user left a named room.
   */
  async leaveRoom(room: string, userId: string): Promise<void> {
    const roomKey = this.roomKey(room);
    await this.redis.srem(roomKey, userId);
  }

  /**
   * Remove a user from all rooms they are in.
   */
  async leaveAllRooms(userId: string): Promise<void> {
    // Scan for all room keys that contain this user
    const pattern = `${this.keyPrefix}:room:*`;
    const keys = await this.scanKeys(pattern);
    if (keys.length === 0) return;

    const pipeline = this.redis.pipeline();
    for (const key of keys) {
      pipeline.srem(key, userId);
    }
    await pipeline.exec();
  }

  // ─── Internals ───────────────────────────────────────────────────────────────

  private async scanKeys(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, batch] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== '0');
    return keys;
  }

  async onModuleDestroy(): Promise<void> {
    // Only quit if we own the connection (created internally)
    if (this.redis.status === 'ready') {
      await this.redis.quit();
    }
  }
}
