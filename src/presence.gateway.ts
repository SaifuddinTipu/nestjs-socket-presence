import { Logger, Optional } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { PRESENCE_EVENTS } from './presence.constants';
import { PresenceService } from './presence.service';

/**
 * PresenceGateway wires Socket.IO lifecycle events to PresenceService automatically.
 *
 * To use it, your client socket must send a userId on connect:
 *   socket.auth = { userId: 'user-123' }
 *   socket.connect()
 *
 * Or emit 'presence:identify' after connecting:
 *   socket.emit('presence:identify', { userId: 'user-123', metadata: { role: 'agent' } })
 */
@WebSocketGateway({ cors: { origin: '*' } })
export class PresenceGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(PresenceGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(private readonly presenceService: PresenceService) {}

  async handleConnection(client: Socket): Promise<void> {
    // Support auth handshake: socket.auth = { userId }
    const userId = this.extractUserId(client);
    if (userId) {
      await this.markOnline(client, userId);
    }
    // If no userId on connect, wait for 'presence:identify' event
  }

  async handleDisconnect(client: Socket): Promise<void> {
    const { userId, wentOffline } = await this.presenceService.removeSocket(client.id);

    if (!userId) return;

    if (wentOffline) {
      await this.presenceService.leaveAllRooms(userId);
      this.server.emit(PRESENCE_EVENTS.USER_OFFLINE, { userId, socketId: client.id });
      this.logger.debug(`presence:offline → ${userId}`);
    }
  }

  /**
   * Client emits this after connecting if userId was not in handshake auth.
   * payload: { userId: string; metadata?: Record<string, unknown> }
   */
  @SubscribeMessage(PRESENCE_EVENTS.HEARTBEAT.replace(':heartbeat', ':identify'))
  async handleIdentify(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { userId: string; metadata?: Record<string, unknown> },
  ): Promise<void> {
    if (!payload?.userId) return;
    await this.markOnline(client, payload.userId, payload.metadata);
  }

  /**
   * Client emits this on a timer (recommended every ttl/2 seconds) to keep presence alive.
   * payload: { userId: string }
   */
  @SubscribeMessage(PRESENCE_EVENTS.HEARTBEAT)
  async handleHeartbeat(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { userId: string },
  ): Promise<void> {
    if (!payload?.userId) return;
    await this.presenceService.heartbeat(payload.userId, client.id);
  }

  /**
   * Client joins a presence-tracked room.
   * payload: { userId: string; room: string }
   */
  @SubscribeMessage(PRESENCE_EVENTS.ROOM_JOIN)
  async handleRoomJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { userId: string; room: string },
  ): Promise<void> {
    if (!payload?.userId || !payload?.room) return;
    await this.presenceService.joinRoom(payload.room, payload.userId);
    client.join(payload.room);
    this.server.to(payload.room).emit(PRESENCE_EVENTS.ROOM_JOIN, {
      userId: payload.userId,
      room: payload.room,
    });
  }

  /**
   * Client leaves a presence-tracked room.
   * payload: { userId: string; room: string }
   */
  @SubscribeMessage(PRESENCE_EVENTS.ROOM_LEAVE)
  async handleRoomLeave(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { userId: string; room: string },
  ): Promise<void> {
    if (!payload?.userId || !payload?.room) return;
    await this.presenceService.leaveRoom(payload.room, payload.userId);
    client.leave(payload.room);
    this.server.to(payload.room).emit(PRESENCE_EVENTS.ROOM_LEAVE, {
      userId: payload.userId,
      room: payload.room,
    });
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private async markOnline(
    client: Socket,
    userId: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.presenceService.setOnline(userId, client.id, metadata);
    this.server.emit(PRESENCE_EVENTS.USER_ONLINE, { userId, socketId: client.id });
    this.logger.debug(`presence:online → ${userId}`);
  }

  private extractUserId(client: Socket): string | null {
    const auth = (client as unknown as { handshake: { auth?: { userId?: string } } }).handshake?.auth;
    return auth?.userId ?? null;
  }
}
