# nestjs-socket-presence — Complete Usage Guide

## Table of Contents

1. [Installation](#installation)
2. [How It Works](#how-it-works)
3. [Module Setup](#module-setup)
4. [Client Integration](#client-integration)
5. [API Reference](#api-reference)
6. [Real-World Scenarios](#real-world-scenarios)
7. [Testing Guide](#testing-guide)
8. [Troubleshooting](#troubleshooting)

---

## Installation

```bash
npm install nestjs-socket-presence ioredis
npm install @nestjs/common @nestjs/core @nestjs/websockets socket.io
```

---

## How It Works

```
Client connects via Socket.IO
        │
        ▼
PresenceGateway.handleConnection()
        │
        ▼
PresenceService.setOnline(userId, socketId)
        │
        ▼
Redis stores:
  presence:user:{userId}         → HASH { online: 1, lastSeen, metadata }
  presence:user:{userId}:sockets → SET  { socketId1, socketId2, ... }
  presence:socket:{socketId}     → STRING userId

Client disconnects
        │
        ▼
PresenceGateway.handleDisconnect()
        │
        ▼
PresenceService.removeSocket(socketId)
        │
        ├─ Sockets remain? → Update lastSeen only
        └─ No sockets left? → setOffline(userId)
                              leaveAllRooms(userId)
                              broadcast presence:offline
```

---

## Module Setup

### Option A — Synchronous (direct config)

```typescript
// app.module.ts
import { Module } from '@nestjs/common';
import { PresenceModule } from 'nestjs-socket-presence';

@Module({
  imports: [
    PresenceModule.register({
      redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
        password: process.env.REDIS_PASSWORD,
      },
      ttl: 30,          // seconds — user goes offline after 30s without heartbeat
      keyPrefix: 'presence',  // optional Redis key prefix
    }),
  ],
})
export class AppModule {}
```

### Option B — Async (with ConfigService)

```typescript
// app.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PresenceModule } from 'nestjs-socket-presence';

@Module({
  imports: [
    ConfigModule.forRoot(),
    PresenceModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        redis: {
          url: config.get<string>('REDIS_URL'),
        },
        ttl: config.get<number>('PRESENCE_TTL') || 30,
      }),
      inject: [ConfigService],
    }),
  ],
})
export class AppModule {}
```

### Environment Variables

```env
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=yourpassword
REDIS_URL=redis://:yourpassword@localhost:6379
PRESENCE_TTL=30
```

---

## Client Integration

### Browser / React

```typescript
import { io, Socket } from 'socket.io-client';

let socket: Socket;

// Option A — userId in handshake (auto presence on connect)
function connectWithPresence(userId: string) {
  socket = io('http://localhost:3000', {
    auth: { userId },
    transports: ['websocket'],
  });

  // Listen for presence events
  socket.on('presence:online', ({ userId, socketId }) => {
    console.log(`${userId} is now online`);
    updateUserStatus(userId, true);
  });

  socket.on('presence:offline', ({ userId, socketId }) => {
    console.log(`${userId} is now offline`);
    updateUserStatus(userId, false);
  });

  socket.on('presence:room:join', ({ userId, room }) => {
    console.log(`${userId} joined room ${room}`);
  });

  socket.on('presence:room:leave', ({ userId, room }) => {
    console.log(`${userId} left room ${room}`);
  });

  // Heartbeat — keep presence alive every 15s (half of ttl=30)
  const heartbeatInterval = setInterval(() => {
    socket.emit('presence:heartbeat', { userId });
  }, 15_000);

  socket.on('disconnect', () => {
    clearInterval(heartbeatInterval);
  });

  return socket;
}

// Option B — identify after connecting (e.g. after JWT auth)
function connectAndIdentify(token: string) {
  socket = io('http://localhost:3000', { transports: ['websocket'] });

  socket.on('connect', () => {
    // Authenticate first, then identify presence
    socket.emit('auth', { token }, (userId: string) => {
      socket.emit('presence:identify', {
        userId,
        metadata: { role: 'agent', department: 'billing' },
      });
    });
  });
}
```

### Join a Presence-Tracked Room

```typescript
// Join a room — presence tracked
socket.emit('presence:room:join', { userId: 'user-123', room: 'support-tier-1' });

// Leave a room
socket.emit('presence:room:leave', { userId: 'user-123', room: 'support-tier-1' });
```

---

## API Reference

### `PresenceService`

Inject into any provider:

```typescript
import { Injectable } from '@nestjs/common';
import { PresenceService, UserPresence, RoomPresence } from 'nestjs-socket-presence';

@Injectable()
export class AgentService {
  constructor(private readonly presence: PresenceService) {}
}
```

#### `setOnline(userId, socketId, metadata?)`

```typescript
await this.presence.setOnline('user-123', 'socket-abc', {
  role: 'senior-agent',
  department: 'billing',
  region: 'us-east',
});
```

#### `setOffline(userId)`

```typescript
await this.presence.setOffline('user-123');
```

#### `isOnline(userId) → Promise<boolean>`

```typescript
const available = await this.presence.isOnline('agent-456');
if (!available) {
  throw new Error('Agent is not available');
}
```

#### `getUserPresence(userId) → Promise<UserPresence | null>`

```typescript
const presence = await this.presence.getUserPresence('user-123');
// {
//   userId: 'user-123',
//   online: true,
//   socketIds: ['socket-abc', 'socket-def'],  // all open tabs/devices
//   lastSeen: 1700000000000,
//   metadata: { role: 'senior-agent' }
// }
```

#### `getBulkPresence(userIds) → Promise<Map<string, boolean>>`

```typescript
const agentIds = ['agent-1', 'agent-2', 'agent-3', 'agent-4'];
const statusMap = await this.presence.getBulkPresence(agentIds);

const onlineAgents = agentIds.filter(id => statusMap.get(id) === true);
console.log(`${onlineAgents.length} agents available`);
```

#### `getRoomPresence(room) → Promise<RoomPresence>`

```typescript
const room = await this.presence.getRoomPresence('support-tier-1');
// {
//   room: 'support-tier-1',
//   onlineCount: 3,
//   users: [
//     { userId: 'agent-1', online: true, socketIds: [...], lastSeen: ... },
//     { userId: 'agent-2', online: true, ... },
//   ]
// }
```

#### `joinRoom(room, userId)` / `leaveRoom(room, userId)`

```typescript
await this.presence.joinRoom('project-42', 'user-123');
await this.presence.leaveRoom('project-42', 'user-123');
```

#### `heartbeat(userId, socketId)`

```typescript
// Called from your gateway when client emits a heartbeat
await this.presence.heartbeat('user-123', 'socket-abc');
```

---

## Real-World Scenarios

### Scenario 1 — Customer Support Platform

**Setup:** Route incoming chats to available agents only.

```typescript
// chat-routing.service.ts
@Injectable()
export class ChatRoutingService {
  constructor(
    private readonly presence: PresenceService,
    private readonly agentRepo: AgentRepository,
  ) {}

  async routeChat(customerId: string, department: string): Promise<string | null> {
    // Get all agents in the department
    const agents = await this.agentRepo.findByDepartment(department);
    const agentIds = agents.map(a => a.id);

    // Bulk check who is online — single Redis round-trip
    const statusMap = await this.presence.getBulkPresence(agentIds);
    const onlineAgents = agents.filter(a => statusMap.get(a.id) === true);

    if (onlineAgents.length === 0) {
      return null; // No agents available — queue the chat
    }

    // Round-robin or least-busy selection
    const selected = onlineAgents[Math.floor(Math.random() * onlineAgents.length)];

    // Join both to the chat room
    await this.presence.joinRoom(`chat-${customerId}`, selected.id);

    return selected.id;
  }

  async getAgentRoomStatus(agentId: string): Promise<RoomPresence[]> {
    // See which rooms this agent is currently active in
    // (implemented by querying your own room-agent mapping)
    const rooms = await this.agentRepo.getActiveRooms(agentId);
    return Promise.all(rooms.map(r => this.presence.getRoomPresence(r)));
  }
}
```

**Test this scenario:**

```bash
# Start Redis
docker run -p 6379:6379 redis:alpine

# Start your NestJS app
npm run start:dev

# In browser console — simulate 3 agents connecting
const a1 = io('http://localhost:3000', { auth: { userId: 'agent-1' } });
const a2 = io('http://localhost:3000', { auth: { userId: 'agent-2' } });
const a3 = io('http://localhost:3000', { auth: { userId: 'agent-3' } });

# Disconnect one agent
a2.disconnect();

# GET /agents/available — should now return agent-1 and agent-3 only
curl http://localhost:3000/agents/available
```

---

### Scenario 2 — Collaborative Document Editor

**Setup:** Show "X people are viewing this document" in real time.

```typescript
// document.gateway.ts
import { SubscribeMessage, WebSocketGateway, ConnectedSocket, MessageBody } from '@nestjs/websockets';
import { Socket } from 'socket.io';
import { PresenceService } from 'nestjs-socket-presence';

@WebSocketGateway({ cors: { origin: '*' } })
export class DocumentGateway {
  constructor(private readonly presence: PresenceService) {}

  @SubscribeMessage('document:open')
  async handleDocumentOpen(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { userId: string; documentId: string },
  ) {
    const room = `doc-${body.documentId}`;
    await this.presence.joinRoom(room, body.userId);
    client.join(room);

    const roomPresence = await this.presence.getRoomPresence(room);
    // Broadcast updated viewer count to everyone in the room
    client.to(room).emit('document:viewers', {
      count: roomPresence.onlineCount,
      users: roomPresence.users.map(u => u.userId),
    });
  }

  @SubscribeMessage('document:close')
  async handleDocumentClose(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { userId: string; documentId: string },
  ) {
    const room = `doc-${body.documentId}`;
    await this.presence.leaveRoom(room, body.userId);
    client.leave(room);

    const roomPresence = await this.presence.getRoomPresence(room);
    client.to(room).emit('document:viewers', {
      count: roomPresence.onlineCount,
    });
  }
}
```

**Test this scenario:**

```typescript
// Open 3 browser tabs and connect to the same document
const user1 = io('http://localhost:3000', { auth: { userId: 'user-1' } });
const user2 = io('http://localhost:3000', { auth: { userId: 'user-2' } });
const user3 = io('http://localhost:3000', { auth: { userId: 'user-3' } });

user1.emit('document:open', { userId: 'user-1', documentId: 'doc-42' });
user2.emit('document:open', { userId: 'user-2', documentId: 'doc-42' });
user3.emit('document:open', { userId: 'user-3', documentId: 'doc-42' });
// → All clients receive: { count: 3, users: ['user-1', 'user-2', 'user-3'] }

user2.disconnect();
// → Remaining clients receive: { count: 2 }
```

---

### Scenario 3 — Multi-Tab User (Ghost User Prevention)

**Setup:** User opens 3 tabs. Each tab creates a socket. User closes 2 tabs — should still be online. Closes last tab — goes offline.

```typescript
// Test in browser console
const tab1 = io('http://localhost:3000', { auth: { userId: 'user-123' } });
const tab2 = io('http://localhost:3000', { auth: { userId: 'user-123' } });
const tab3 = io('http://localhost:3000', { auth: { userId: 'user-123' } });

// Check Redis directly
// presence:user:user-123:sockets → { tab1-socketId, tab2-socketId, tab3-socketId }

tab1.disconnect();
// User still online (2 sockets remain)

tab2.disconnect();
// User still online (1 socket remains)

tab3.disconnect();
// NOW: presence:offline event broadcast
// presence:user:user-123 → { online: 0 }
```

---

### Scenario 4 — Ghost User via Network Drop (TTL Expiry)

**Setup:** User's internet drops — no disconnect event fires. TTL cleans them up.

```typescript
// Set a short TTL for testing
PresenceModule.register({
  redis: { host: 'localhost', port: 6379 },
  ttl: 10, // 10 seconds for testing
})

// Client connects
const socket = io('http://localhost:3000', { auth: { userId: 'user-999' } });

// Do NOT send heartbeats — simulate a dropped connection
// After ~20 seconds (2x TTL), Redis expires the key
// User is automatically gone from presence

// Verify via your API:
// GET /users/user-999/presence → { online: false }
```

---

### Scenario 5 — Agent Metadata (Role-Based Routing)

**Setup:** Pass role/department metadata on connect for intelligent routing.

```typescript
// Client
socket = io('http://localhost:3000', {
  auth: { userId: 'agent-789' },
});

// After auth, identify with metadata
socket.emit('presence:identify', {
  userId: 'agent-789',
  metadata: {
    role: 'senior-agent',
    department: 'technical-support',
    languages: ['en', 'ms'],
    maxConcurrentChats: 5,
  },
});

// Server — route based on metadata
const room = await this.presence.getRoomPresence('technical-support');
const seniorAgents = room.users.filter(
  u => u.metadata?.role === 'senior-agent'
);
```

---

## Testing Guide

### Unit Test — `PresenceService`

```typescript
// presence.service.spec.ts
import { Test } from '@nestjs/testing';
import { PresenceService } from 'nestjs-socket-presence';
import { PRESENCE_MODULE_OPTIONS, PRESENCE_REDIS_CLIENT } from 'nestjs-socket-presence';

describe('PresenceService', () => {
  let service: PresenceService;

  // Use the RedisMock from the library's test suite or ioredis-mock
  const redisMock = new IORedisMock();

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        PresenceService,
        { provide: PRESENCE_REDIS_CLIENT, useValue: redisMock },
        { provide: PRESENCE_MODULE_OPTIONS, useValue: { redis: {}, ttl: 30 } },
      ],
    }).compile();
    service = module.get(PresenceService);
  });

  it('marks user online', async () => {
    await service.setOnline('user-1', 'socket-1');
    expect(await service.isOnline('user-1')).toBe(true);
  });

  it('goes offline when last socket disconnects', async () => {
    await service.setOnline('user-1', 'socket-1');
    await service.setOnline('user-1', 'socket-2');
    await service.removeSocket('socket-1');
    expect(await service.isOnline('user-1')).toBe(true); // still has socket-2
    await service.removeSocket('socket-2');
    expect(await service.isOnline('user-1')).toBe(false); // now offline
  });
});
```

### Integration Test — End to End with Real Redis

```typescript
// presence.e2e.spec.ts
import { io, Socket } from 'socket.io-client';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';

describe('Presence E2E', () => {
  let app: INestApplication;
  let socket1: Socket;
  let socket2: Socket;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = module.createNestApplication();
    await app.listen(3001);
  });

  afterAll(async () => {
    socket1?.disconnect();
    socket2?.disconnect();
    await app.close();
  });

  it('broadcasts presence:online when user connects', (done) => {
    socket2 = io('http://localhost:3001', { auth: { userId: 'user-observer' } });

    socket2.on('presence:online', ({ userId }) => {
      if (userId === 'user-target') {
        expect(userId).toBe('user-target');
        done();
      }
    });

    setTimeout(() => {
      socket1 = io('http://localhost:3001', { auth: { userId: 'user-target' } });
    }, 200);
  });

  it('broadcasts presence:offline when last socket disconnects', (done) => {
    socket2.on('presence:offline', ({ userId }) => {
      if (userId === 'user-target') {
        done();
      }
    });
    socket1.disconnect();
  });
});
```

### Manual Testing with Redis CLI

```bash
# Start Redis
docker run -p 6379:6379 redis:alpine

# Connect a user via browser/Postman WebSocket

# Check presence keys
redis-cli
> KEYS presence:*
> HGETALL presence:user:user-123
> SMEMBERS presence:user:user-123:sockets
> GET presence:socket:<socketId>

# Expected output after connect:
# HGETALL presence:user:user-123
# 1) "userId"
# 2) "user-123"
# 3) "online"
# 4) "1"
# 5) "lastSeen"
# 6) "1700000000000"

# After disconnect:
# HGETALL presence:user:user-123
# 3) "online"
# 4) "0"
```

---

## Troubleshooting

### User never goes offline after disconnect

**Cause:** TTL is not being refreshed and the key expired before the disconnect event.
**Fix:** Ensure clients are sending `presence:heartbeat` every `ttl/2` seconds.

```typescript
// Client
setInterval(() => {
  socket.emit('presence:heartbeat', { userId });
}, (TTL_SECONDS / 2) * 1000);
```

### User shows offline despite being connected (multiple pods)

**Cause:** Each pod has its own in-memory state; Redis is not shared.
**Fix:** Verify all pods connect to the **same Redis instance**. Check `REDIS_URL` env var on each pod.

### Ghost users persisting

**Cause:** Client is not sending heartbeats, and TTL is too long.
**Fix:** Lower `ttl` to 30 seconds and ensure clients heartbeat every 15 seconds.

### `presence:online` fires but `isOnline()` returns false

**Cause:** Race condition — query runs before Redis write completes.
**Fix:** Add a small delay in tests, or ensure you're calling `setOnline` before broadcasting.

### Memory growing in Redis

**Cause:** Room keys (`presence:room:*`) are never cleaned up.
**Fix:** Call `leaveAllRooms(userId)` on disconnect — the `PresenceGateway` does this automatically when you use the built-in gateway.
