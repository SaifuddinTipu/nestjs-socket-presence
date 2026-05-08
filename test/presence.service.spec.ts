import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { PresenceService } from '../src/presence.service';
import {
  DEFAULT_KEY_PREFIX,
  DEFAULT_TTL,
  PRESENCE_MODULE_OPTIONS,
  PRESENCE_REDIS_CLIENT,
} from '../src/presence.constants';

// ─── Minimal Redis mock ───────────────────────────────────────────────────────

class RedisMock {
  private store = new Map<string, string>();
  private sets = new Map<string, Set<string>>();
  private hashes = new Map<string, Map<string, string>>();

  pipeline() {
    const ops: Array<() => Promise<unknown>> = [];
    const pipe = {
      set: (key: string, val: string, ...rest: unknown[]) => {
        ops.push(() => Promise.resolve(this.set(key, val)));
        return pipe;
      },
      get: (key: string) => {
        ops.push(() => Promise.resolve(this.get(key)));
        return pipe;
      },
      del: (...keys: string[]) => {
        ops.push(() => Promise.resolve(this.del(...keys)));
        return pipe;
      },
      sadd: (key: string, ...members: string[]) => {
        ops.push(() => Promise.resolve(this.sadd(key, ...members)));
        return pipe;
      },
      srem: (key: string, ...members: string[]) => {
        ops.push(() => Promise.resolve(this.srem(key, ...members)));
        return pipe;
      },
      expire: (key: string, _ttl: number) => {
        ops.push(() => Promise.resolve(1));
        return pipe;
      },
      hmset: (key: string, data: Record<string, string>) => {
        ops.push(() => Promise.resolve(this.hmset(key, data)));
        return pipe;
      },
      hset: (key: string, ...args: string[]) => {
        ops.push(() => Promise.resolve(this.hset(key, ...args)));
        return pipe;
      },
      exec: async () => {
        const results: Array<[null, unknown]> = [];
        for (const op of ops) {
          results.push([null, await op()]);
        }
        return results;
      },
    };
    return pipe;
  }

  async set(key: string, val: string, ..._rest: unknown[]): Promise<'OK'> {
    this.store.set(key, val);
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const k of keys) {
      if (this.store.delete(k) || this.sets.delete(k) || this.hashes.delete(k)) count++;
    }
    return count;
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    if (!this.sets.has(key)) this.sets.set(key, new Set());
    const s = this.sets.get(key)!;
    let added = 0;
    for (const m of members) {
      if (!s.has(m)) { s.add(m); added++; }
    }
    return added;
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const s = this.sets.get(key);
    if (!s) return 0;
    let removed = 0;
    for (const m of members) {
      if (s.delete(m)) removed++;
    }
    return removed;
  }

  async scard(key: string): Promise<number> {
    return this.sets.get(key)?.size ?? 0;
  }

  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }

  async hmset(key: string, data: Record<string, string>): Promise<'OK'> {
    if (!this.hashes.has(key)) this.hashes.set(key, new Map());
    const h = this.hashes.get(key)!;
    for (const [k, v] of Object.entries(data)) h.set(k, v);
    return 'OK';
  }

  async hset(key: string, ...args: string[]): Promise<number> {
    if (!this.hashes.has(key)) this.hashes.set(key, new Map());
    const h = this.hashes.get(key)!;
    for (let i = 0; i < args.length; i += 2) {
      h.set(args[i], args[i + 1]);
    }
    return args.length / 2;
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.hashes.get(key)?.get(field) ?? null;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const h = this.hashes.get(key);
    if (!h) return {};
    return Object.fromEntries(h.entries());
  }

  async scan(cursor: string, _match: string, _pattern: string, _count: string, _n: number): Promise<[string, string[]]> {
    // Return all room keys matching the pattern
    const allKeys = [
      ...this.store.keys(),
      ...this.sets.keys(),
      ...this.hashes.keys(),
    ];
    return ['0', allKeys];
  }

  async expire(_key: string, _ttl: number): Promise<1> {
    return 1;
  }

  status = 'ready';
  async quit(): Promise<'OK'> { return 'OK'; }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PresenceService', () => {
  let service: PresenceService;
  let redis: RedisMock;

  beforeEach(async () => {
    redis = new RedisMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PresenceService,
        { provide: PRESENCE_REDIS_CLIENT, useValue: redis },
        {
          provide: PRESENCE_MODULE_OPTIONS,
          useValue: { redis: { host: 'localhost', port: 6379 }, ttl: DEFAULT_TTL },
        },
      ],
    }).compile();

    service = module.get<PresenceService>(PresenceService);
  });

  describe('setOnline', () => {
    it('marks a user as online', async () => {
      await service.setOnline('user-1', 'socket-1');
      const online = await service.isOnline('user-1');
      expect(online).toBe(true);
    });

    it('stores metadata when provided', async () => {
      await service.setOnline('user-1', 'socket-1', { role: 'agent' });
      const presence = await service.getUserPresence('user-1');
      expect(presence?.metadata).toEqual({ role: 'agent' });
    });

    it('tracks the socketId', async () => {
      await service.setOnline('user-1', 'socket-1');
      const presence = await service.getUserPresence('user-1');
      expect(presence?.socketIds).toContain('socket-1');
    });

    it('accumulates multiple sockets for the same user', async () => {
      await service.setOnline('user-1', 'socket-1');
      await service.setOnline('user-1', 'socket-2');
      const presence = await service.getUserPresence('user-1');
      expect(presence?.socketIds).toHaveLength(2);
      expect(presence?.socketIds).toContain('socket-1');
      expect(presence?.socketIds).toContain('socket-2');
    });
  });

  describe('setOffline', () => {
    it('marks a user as offline', async () => {
      await service.setOnline('user-1', 'socket-1');
      await service.setOffline('user-1');
      const online = await service.isOnline('user-1');
      expect(online).toBe(false);
    });

    it('clears socket tracking on setOffline', async () => {
      await service.setOnline('user-1', 'socket-1');
      await service.setOffline('user-1');
      const presence = await service.getUserPresence('user-1');
      expect(presence?.socketIds).toHaveLength(0);
    });
  });

  describe('removeSocket', () => {
    it('returns wentOffline=true when last socket disconnects', async () => {
      await service.setOnline('user-1', 'socket-1');
      const result = await service.removeSocket('socket-1');
      expect(result.userId).toBe('user-1');
      expect(result.wentOffline).toBe(true);
    });

    it('returns wentOffline=false when other sockets remain', async () => {
      await service.setOnline('user-1', 'socket-1');
      await service.setOnline('user-1', 'socket-2');
      const result = await service.removeSocket('socket-1');
      expect(result.userId).toBe('user-1');
      expect(result.wentOffline).toBe(false);
    });

    it('returns userId=null for unknown socketId', async () => {
      const result = await service.removeSocket('unknown-socket');
      expect(result.userId).toBeNull();
      expect(result.wentOffline).toBe(false);
    });

    it('marks user offline after last socket removed', async () => {
      await service.setOnline('user-1', 'socket-1');
      await service.removeSocket('socket-1');
      const online = await service.isOnline('user-1');
      expect(online).toBe(false);
    });
  });

  describe('isOnline', () => {
    it('returns false for unknown user', async () => {
      const online = await service.isOnline('nobody');
      expect(online).toBe(false);
    });

    it('returns true after setOnline', async () => {
      await service.setOnline('user-2', 'socket-2');
      expect(await service.isOnline('user-2')).toBe(true);
    });
  });

  describe('getUserPresence', () => {
    it('returns null for unknown user', async () => {
      const presence = await service.getUserPresence('nobody');
      expect(presence).toBeNull();
    });

    it('returns full presence object', async () => {
      await service.setOnline('user-1', 'socket-1');
      const presence = await service.getUserPresence('user-1');
      expect(presence).toMatchObject({
        userId: 'user-1',
        online: true,
        socketIds: ['socket-1'],
      });
      expect(presence?.lastSeen).toBeGreaterThan(0);
    });
  });

  describe('getBulkPresence', () => {
    it('returns empty map for empty input', async () => {
      const result = await service.getBulkPresence([]);
      expect(result.size).toBe(0);
    });

    it('correctly maps online/offline for multiple users', async () => {
      await service.setOnline('user-1', 'socket-1');
      await service.setOnline('user-2', 'socket-2');
      await service.setOffline('user-2');

      const result = await service.getBulkPresence(['user-1', 'user-2', 'user-3']);
      expect(result.get('user-1')).toBe(true);
      expect(result.get('user-2')).toBe(false);
      expect(result.get('user-3')).toBe(false);
    });
  });

  describe('room presence', () => {
    it('tracks users in a room', async () => {
      await service.setOnline('user-1', 'socket-1');
      await service.joinRoom('chat-room', 'user-1');
      const room = await service.getRoomPresence('chat-room');
      expect(room.onlineCount).toBe(1);
      expect(room.users[0].userId).toBe('user-1');
    });

    it('leaveRoom removes user from room', async () => {
      await service.setOnline('user-1', 'socket-1');
      await service.joinRoom('chat-room', 'user-1');
      await service.leaveRoom('chat-room', 'user-1');
      const room = await service.getRoomPresence('chat-room');
      expect(room.onlineCount).toBe(0);
    });

    it('getRoomPresence only counts online users', async () => {
      await service.setOnline('user-1', 'socket-1');
      await service.setOnline('user-2', 'socket-2');
      await service.joinRoom('room-1', 'user-1');
      await service.joinRoom('room-1', 'user-2');
      await service.setOffline('user-2');

      const room = await service.getRoomPresence('room-1');
      expect(room.onlineCount).toBe(1);
      expect(room.users.map((u) => u.userId)).toContain('user-1');
    });

    it('leaveAllRooms clears user from every room', async () => {
      await service.setOnline('user-1', 'socket-1');
      await service.joinRoom('room-a', 'user-1');
      await service.joinRoom('room-b', 'user-1');
      await service.leaveAllRooms('user-1');

      const roomA = await service.getRoomPresence('room-a');
      const roomB = await service.getRoomPresence('room-b');
      expect(roomA.onlineCount).toBe(0);
      expect(roomB.onlineCount).toBe(0);
    });
  });

  describe('heartbeat', () => {
    it('does not throw', async () => {
      await service.setOnline('user-1', 'socket-1');
      await expect(service.heartbeat('user-1', 'socket-1')).resolves.not.toThrow();
    });
  });

  describe('onModuleDestroy', () => {
    it('quits redis when status is ready', async () => {
      const spy = jest.spyOn(redis, 'quit');
      await service.onModuleDestroy();
      expect(spy).toHaveBeenCalled();
    });
  });
});
