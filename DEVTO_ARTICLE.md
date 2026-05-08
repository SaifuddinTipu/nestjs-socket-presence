---
title: "Real-Time User Presence in NestJS — Multi-Tab, Multi-Instance, Zero Ghost Users"
published: true
description: "nestjs-socket-presence — a drop-in NestJS module for Socket.IO presence tracking with Redis. Handles multi-tab users, horizontal scaling, TTL expiry, and room presence out of the box."
tags: nestjs, socketio, redis, typescript
cover_image: https://dev-to-uploads.s3.amazonaws.com/uploads/articles/placeholder.png
canonical_url: https://dev.to/saifuddintipu/nestjs-socket-presence
---

"Is this user online?" sounds like a simple question. Until you actually try to answer it reliably.

I've worked on apps where the presence indicator was basically decorative — it showed "online" for users who had closed the tab 10 minutes ago. It showed "offline" for users who had three tabs open and just closed one. It worked fine on a single server and completely broke when we scaled horizontally.

So I built **[nestjs-socket-presence](https://www.npmjs.com/package/nestjs-socket-presence)** — a NestJS module that gets presence right.

---

## The problems it solves

### Problem 1: Multi-tab users

A user opens your app in 3 tabs. They close tab 1. Are they offline?

No — they still have 2 active connections. But a naive implementation marks them offline the moment any socket disconnects.

`nestjs-socket-presence` tracks a **SET of socket IDs per user** in Redis. The user only goes offline when the last socket is removed.

```
presence:user:{userId}:sockets  →  SET { socketId1, socketId2, socketId3 }
```

Close one tab → 2 remaining → still online.  
Close all tabs → SET is empty → offline event fires.

### Problem 2: Ghost users (ungraceful disconnects)

A user's laptop dies. No `disconnect` event fires. They stay "online" forever.

The fix: **Redis TTL + heartbeat**. Every user key expires after `2 × ttl` seconds unless the client sends a heartbeat.

```typescript
// Client — keep presence alive
setInterval(() => {
  socket.emit('presence:heartbeat', { userId: 'user-123' });
}, 15_000); // every 15s when ttl=30
```

No heartbeat = key expires = user goes offline automatically. No cron jobs, no cleanup workers.

### Problem 3: Horizontal scaling

Two NestJS instances, same Redis. A user connects to instance A. A query on instance B asks if they're online.

Because all state lives in Redis (not in-process memory), **any instance can answer any presence query**. Zero coordination needed.

```
Instance A ──────┐
                 │  both read/write to
Instance B ──────┤  the same Redis keys
                 │
             Redis ← single source of truth
```

---

## Installation

```bash
npm install nestjs-socket-presence ioredis
```

---

## Setup

```typescript
// app.module.ts
import { PresenceModule } from 'nestjs-socket-presence';

@Module({
  imports: [
    PresenceModule.register({
      redis: { host: 'localhost', port: 6379 },
      ttl: 30, // seconds — users go offline after 30s without heartbeat
    }),
  ],
})
export class AppModule {}
```

That's the entire setup. The module auto-registers a Socket.IO gateway that handles connect/disconnect/heartbeat/rooms.

---

## Connect from the browser

```typescript
import { io } from 'socket.io-client';

const socket = io('http://localhost:3000', {
  auth: { userId: 'user-123' }, // presence tracked automatically on connect
});

// Heartbeat to prevent ghost-user TTL expiry
setInterval(() => {
  socket.emit('presence:heartbeat', { userId: 'user-123' });
}, 15_000);
```

On connect → `presence:online` broadcast fires.  
On disconnect (last socket) → `presence:offline` broadcast fires.  
No heartbeat for 30s → key expires → effectively offline.

---

## Querying presence

Inject `PresenceService` anywhere:

```typescript
import { PresenceService } from 'nestjs-socket-presence';

@Injectable()
export class ChatService {
  constructor(private readonly presence: PresenceService) {}

  // Single user
  async isAgentAvailable(agentId: string): Promise<boolean> {
    return this.presence.isOnline(agentId);
  }

  // Full presence object (includes socketIds, lastSeen, metadata)
  async getUserStatus(userId: string) {
    return this.presence.getUserPresence(userId);
    // → { userId, online, socketIds, lastSeen, metadata? }
  }

  // Bulk check — one Redis round-trip for hundreds of users
  async getTeamStatus(userIds: string[]) {
    return this.presence.getBulkPresence(userIds);
    // → Map<string, boolean>
  }
}
```

---

## Room presence

Track who is online in a specific room — useful for collaborative features:

```typescript
// Client joins a document room
socket.emit('presence:room:join', { userId: 'user-123', room: 'doc:abc' });

// Server queries who's in the room
const roomState = await this.presence.getRoomPresence('doc:abc');
// → { room: 'doc:abc', users: [UserPresence, ...], onlineCount: 4 }
```

---

## Custom metadata

Pass arbitrary data when a user comes online — useful for routing, labeling, or filtering:

```typescript
// From your own gateway or auth interceptor
await this.presenceService.setOnline(userId, socket.id, {
  role: 'support-agent',
  region: 'us-east',
  tier: 'premium',
});

// Read it back in a query
const presence = await this.presenceService.getUserPresence(userId);
console.log(presence?.metadata);
// → { role: 'support-agent', region: 'us-east', tier: 'premium' }
```

This makes it possible to build things like "route this chat to the nearest online premium agent."

---

## Events reference

### Client → Server

| Event | Payload | When to use |
|-------|---------|-------------|
| `presence:identify` | `{ userId, metadata? }` | If userId wasn't in socket auth |
| `presence:heartbeat` | `{ userId }` | Every `ttl/2` seconds |
| `presence:room:join` | `{ userId, room }` | Enter a collaborative space |
| `presence:room:leave` | `{ userId, room }` | Exit a collaborative space |

### Server → Client (broadcast to all)

| Event | Payload |
|-------|---------|
| `presence:online` | `{ userId, socketId }` |
| `presence:offline` | `{ userId, socketId }` |
| `presence:room:join` | `{ userId, room }` |
| `presence:room:leave` | `{ userId, room }` |

---

## Real-world use case: Customer support routing

```typescript
@Injectable()
export class TicketRouter {
  constructor(private readonly presence: PresenceService) {}

  async assignTicket(ticket: Ticket): Promise<string | null> {
    const agents = await this.getAgentsForDepartment(ticket.department);
    const presenceMap = await this.presence.getBulkPresence(
      agents.map(a => a.userId)
    );

    const onlineAgents = agents.filter(a => presenceMap.get(a.userId));
    if (onlineAgents.length === 0) return null;

    // Pick least-busy online agent
    return onlineAgents.sort((a, b) => a.activeTickets - b.activeTickets)[0].userId;
  }
}
```

No polling. No stale cache. The answer is always current because it reads directly from Redis.

---

## How it stores data in Redis

```
presence:user:{userId}          HASH   → { userId, online, lastSeen, metadata? }
presence:user:{userId}:sockets  SET    → { socketId1, socketId2, ... }
presence:socket:{socketId}      STRING → userId
presence:room:{room}            SET    → { userId1, userId2, ... }
```

All user keys have a TTL of `2 × ttl` seconds. Heartbeat refreshes the TTL on every pulse.

---

## Async configuration

```typescript
PresenceModule.registerAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    redis: {
      host: config.get('REDIS_HOST'),
      port: config.get<number>('REDIS_PORT'),
      password: config.get('REDIS_PASSWORD'),
    },
    ttl: 30,
  }),
})
```

---

## Tests

The package ships with 22 tests using an in-memory Redis mock — no real Redis required for unit tests:

```bash
npm test
# PASS  test/presence.service.spec.ts (22 tests)
```

The test suite covers:
- Single and multi-socket user flows
- TTL expiry edge cases
- Room join/leave/cleanup
- Bulk presence queries
- Metadata persistence
- Ghost user prevention (socket removed without explicit offline)

---

## Why not Socket.IO rooms for presence?

Socket.IO rooms are in-process. They don't survive restarts and don't work across multiple server instances without the Redis adapter — and even then, querying "who is in this room" isn't straightforward.

`nestjs-socket-presence` stores everything in Redis explicitly, so:
- Any instance can query any user's presence
- Data survives server restarts (within TTL)
- You can query presence from non-WebSocket code (HTTP handlers, cron jobs, etc.)

---

## Links

- **npm:** [npmjs.com/package/nestjs-socket-presence](https://www.npmjs.com/package/nestjs-socket-presence)
- **GitHub:** [github.com/SaifuddinTipu/nestjs-socket-presence](https://github.com/SaifuddinTipu/nestjs-socket-presence)
- **USAGE.md** — detailed scenarios including collaborative editor, multi-tab ghost prevention, E2E tests, and Redis CLI debugging guide

If this saves you from building the same thing from scratch, a ⭐ on GitHub is appreciated. Bug reports and PRs welcome.
