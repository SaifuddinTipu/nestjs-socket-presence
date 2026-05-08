# nestjs-socket-presence

[![npm version](https://img.shields.io/npm/v/nestjs-socket-presence.svg)](https://www.npmjs.com/package/nestjs-socket-presence)
[![npm downloads](https://img.shields.io/npm/dm/nestjs-socket-presence.svg)](https://www.npmjs.com/package/nestjs-socket-presence)
[![license](https://img.shields.io/npm/l/nestjs-socket-presence.svg)](LICENSE)
[![tests](https://img.shields.io/badge/tests-22%20passing-brightgreen.svg)](https://github.com/SaifuddinTipu/nestjs-socket-presence)

> Drop-in NestJS module for real-time user presence tracking via **Socket.IO** and **Redis**.  
> Works across horizontally-scaled NestJS instances. Zero boilerplate.

---

## Features

- ✅ **Online / offline tracking** — automatic on socket connect & disconnect
- ✅ **Multi-socket per user** — one user, many tabs/devices, single presence state
- ✅ **Redis TTL expiry** — ungraceful disconnects auto-expire (no ghost users)
- ✅ **Heartbeat support** — clients can refresh TTL on a timer
- ✅ **Room presence** — track who is online in a named room
- ✅ **Bulk presence queries** — check hundreds of users in one Redis round-trip
- ✅ **Multi-instance safe** — Redis-backed, works behind a load balancer
- ✅ **`register` + `registerAsync`** — works with ConfigService / async factories
- ✅ **Full TypeScript** — typed interfaces for all inputs and outputs

---

## Installation

```bash
npm install nestjs-socket-presence ioredis
```

**Peer dependencies** (install if not already present):

```bash
npm install @nestjs/common @nestjs/core @nestjs/websockets socket.io
```

---

## Quick Start

### 1. Import the module

```typescript
// app.module.ts
import { PresenceModule } from 'nestjs-socket-presence';

@Module({
  imports: [
    PresenceModule.register({
      redis: { host: 'localhost', port: 6379 },
      ttl: 30,        // seconds — users go offline after 30s without heartbeat
    }),
  ],
})
export class AppModule {}
```

### 2. Connect from the client

```typescript
// Browser / client
import { io } from 'socket.io-client';

const socket = io('http://localhost:3000', {
  auth: { userId: 'user-123' },   // userId in handshake → auto presence on connect
});
```

That's it. The user is now tracked as online. On disconnect they go offline automatically.

---

## Async Registration (with ConfigService)

```typescript
PresenceModule.registerAsync({
  imports: [ConfigModule],
  useFactory: (config: ConfigService) => ({
    redis: { url: config.get('REDIS_URL') },
    ttl: 30,
  }),
  inject: [ConfigService],
})
```

---

## Using PresenceService

Inject `PresenceService` into any provider or controller:

```typescript
import { PresenceService } from 'nestjs-socket-presence';

@Injectable()
export class ChatService {
  constructor(private readonly presence: PresenceService) {}

  async getAgentStatus(agentId: string) {
    return this.presence.isOnline(agentId);
  }

  async getFullPresence(userId: string) {
    return this.presence.getUserPresence(userId);
    // → { userId, online, socketIds, lastSeen, metadata? }
  }

  async checkWhoIsOnline(userIds: string[]) {
    return this.presence.getBulkPresence(userIds);
    // → Map<string, boolean>
  }

  async getRoomStatus(room: string) {
    return this.presence.getRoomPresence(room);
    // → { room, users: UserPresence[], onlineCount }
  }
}
```

---

## Socket.IO Events

### Client → Server

| Event | Payload | Description |
|-------|---------|-------------|
| `presence:identify` | `{ userId, metadata? }` | Identify after connect (if userId not in auth) |
| `presence:heartbeat` | `{ userId }` | Refresh TTL — call every `ttl/2` seconds |
| `presence:room:join` | `{ userId, room }` | Join a presence-tracked room |
| `presence:room:leave` | `{ userId, room }` | Leave a presence-tracked room |

### Server → Client (broadcast)

| Event | Payload | Description |
|-------|---------|-------------|
| `presence:online` | `{ userId, socketId }` | A user came online |
| `presence:offline` | `{ userId, socketId }` | A user went offline |
| `presence:room:join` | `{ userId, room }` | A user joined a room |
| `presence:room:leave` | `{ userId, room }` | A user left a room |

### Client heartbeat example

```typescript
// Keep presence alive while connected
setInterval(() => {
  socket.emit('presence:heartbeat', { userId: 'user-123' });
}, 15_000); // every 15s when ttl=30
```

---

## API Reference

### PresenceService

```typescript
// Mark online (called automatically by PresenceGateway)
setOnline(userId: string, socketId: string, metadata?: Record<string, unknown>): Promise<void>

// Mark offline explicitly
setOffline(userId: string): Promise<void>

// Remove one socket (called automatically on disconnect)
removeSocket(socketId: string): Promise<{ userId: string | null; wentOffline: boolean }>

// Refresh TTL
heartbeat(userId: string, socketId: string): Promise<void>

// Queries
isOnline(userId: string): Promise<boolean>
getUserPresence(userId: string): Promise<UserPresence | null>
getBulkPresence(userIds: string[]): Promise<Map<string, boolean>>
getRoomPresence(room: string): Promise<RoomPresence>

// Room management
joinRoom(room: string, userId: string): Promise<void>
leaveRoom(room: string, userId: string): Promise<void>
leaveAllRooms(userId: string): Promise<void>
```

### Types

```typescript
interface UserPresence {
  userId: string;
  online: boolean;
  socketIds: string[];
  lastSeen: number;           // Unix timestamp ms
  metadata?: Record<string, unknown>;
}

interface RoomPresence {
  room: string;
  users: UserPresence[];
  onlineCount: number;
}
```

---

## Advanced: Custom metadata

Pass arbitrary metadata when a user comes online — useful for role, region, device type:

```typescript
// Server-side — call from your own gateway or interceptor
await this.presenceService.setOnline(userId, socket.id, {
  role: 'agent',
  region: 'us-east',
  device: 'mobile',
});

// Read it back
const presence = await this.presenceService.getUserPresence(userId);
console.log(presence?.metadata); // { role: 'agent', region: 'us-east', device: 'mobile' }
```

---

## Redis Key Structure

```
presence:user:{userId}          HASH  → { userId, online, lastSeen, metadata? }
presence:user:{userId}:sockets  SET   → { socketId1, socketId2, ... }
presence:socket:{socketId}      STRING → userId
presence:room:{room}            SET   → { userId1, userId2, ... }
```

---

## License

MIT © [Saifuddin Tipu](https://github.com/SaifuddinTipu)
