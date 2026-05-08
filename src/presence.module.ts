import { DynamicModule, Module, Provider } from '@nestjs/common';
import Redis from 'ioredis';
import {
  PRESENCE_MODULE_OPTIONS,
  PRESENCE_REDIS_CLIENT,
} from './presence.constants';
import { PresenceGateway } from './presence.gateway';
import {
  PresenceModuleAsyncOptions,
  PresenceModuleOptions,
} from './presence.interfaces';
import { PresenceService } from './presence.service';

@Module({})
export class PresenceModule {
  /**
   * Synchronous registration.
   *
   * @example
   * PresenceModule.register({
   *   redis: { host: 'localhost', port: 6379 },
   *   ttl: 30,
   * })
   */
  static register(options: PresenceModuleOptions): DynamicModule {
    const optionsProvider: Provider = {
      provide: PRESENCE_MODULE_OPTIONS,
      useValue: options,
    };

    const redisProvider: Provider = {
      provide: PRESENCE_REDIS_CLIENT,
      useFactory: () => PresenceModule.createRedisClient(options),
    };

    return {
      module: PresenceModule,
      providers: [optionsProvider, redisProvider, PresenceService, PresenceGateway],
      exports: [PresenceService],
    };
  }

  /**
   * Asynchronous registration — use when options come from ConfigService or env.
   *
   * @example
   * PresenceModule.registerAsync({
   *   imports: [ConfigModule],
   *   useFactory: (config: ConfigService) => ({
   *     redis: { url: config.get('REDIS_URL') },
   *     ttl: 30,
   *   }),
   *   inject: [ConfigService],
   * })
   */
  static registerAsync(options: PresenceModuleAsyncOptions): DynamicModule {
    const optionsProvider: Provider = {
      provide: PRESENCE_MODULE_OPTIONS,
      useFactory: options.useFactory,
      inject: (options.inject as never[]) ?? [],
    };

    const redisProvider: Provider = {
      provide: PRESENCE_REDIS_CLIENT,
      useFactory: (moduleOptions: PresenceModuleOptions) =>
        PresenceModule.createRedisClient(moduleOptions),
      inject: [PRESENCE_MODULE_OPTIONS],
    };

    return {
      module: PresenceModule,
      imports: options.imports ?? [],
      providers: [optionsProvider, redisProvider, PresenceService, PresenceGateway],
      exports: [PresenceService],
    };
  }

  private static createRedisClient(options: PresenceModuleOptions): Redis {
    const { redis } = options;
    if (redis.url) {
      return new Redis(redis.url);
    }
    return new Redis({
      host: redis.host ?? 'localhost',
      port: redis.port ?? 6379,
      password: redis.password,
      db: redis.db ?? 0,
    });
  }
}
