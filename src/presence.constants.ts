export const PRESENCE_MODULE_OPTIONS = 'PRESENCE_MODULE_OPTIONS';
export const PRESENCE_REDIS_CLIENT = 'PRESENCE_REDIS_CLIENT';

export const PRESENCE_EVENTS = {
  USER_ONLINE: 'presence:online',
  USER_OFFLINE: 'presence:offline',
  HEARTBEAT: 'presence:heartbeat',
  ROOM_JOIN: 'presence:room:join',
  ROOM_LEAVE: 'presence:room:leave',
} as const;

export const DEFAULT_TTL = 30;
export const DEFAULT_KEY_PREFIX = 'presence';
