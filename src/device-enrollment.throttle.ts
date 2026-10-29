import { Module, type DynamicModule } from '@nestjs/common';
import { ThrottlerModule, type ThrottlerStorage } from '@nestjs/throttler';
import Redis from 'ioredis';

const DEVICE_ENROLLMENT_THROTTLER_STORAGE = Symbol('DEVICE_ENROLLMENT_THROTTLER_STORAGE');

const REDIS_INCREMENT_SCRIPT = `
local hitKey = KEYS[1]
local blockKey = KEYS[2]
local ttl = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local blockDuration = tonumber(ARGV[3])

local totalHits = redis.call('INCR', hitKey)
local timeToExpire = redis.call('PTTL', hitKey)
if timeToExpire <= 0 then
  redis.call('PEXPIRE', hitKey, ttl)
  timeToExpire = ttl
end

local isBlocked = redis.call('GET', blockKey)
local timeToBlockExpire = 0
if isBlocked then
  timeToBlockExpire = redis.call('PTTL', blockKey)
elseif totalHits > limit then
  redis.call('SET', blockKey, '1', 'PX', blockDuration)
  isBlocked = '1'
  timeToBlockExpire = blockDuration
end

if isBlocked and timeToBlockExpire <= 0 then
  redis.call('DEL', blockKey)
  redis.call('SET', hitKey, 1, 'PX', ttl)
  totalHits = 1
  timeToExpire = ttl
  isBlocked = false
end

return { totalHits, timeToExpire, isBlocked and 1 or 0, timeToBlockExpire }
`;

/**
 * Redis-backed implementation of Nest ThrottlerStorage.
 * The Lua script increments counters and applies the block atomically,
 * so concurrent API instances cannot race around the configured limit.
 */
export class ThrottlerStorageRedisService implements ThrottlerStorage {
  private readonly redis: Redis;

  constructor(url: string) {
    this.redis = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: (attempt) => attempt <= 3 ? Math.min(attempt * 100, 1_000) : null,
    });
  }

  async connect(): Promise<void> {
    await this.redis.connect();
    await this.redis.ping();
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ) {
    const hitKey = `{throttle:${key}:${throttlerName}}:hits`;
    const blockKey = `{throttle:${key}:${throttlerName}}:blocked`;
    const raw = await this.redis.eval(
      REDIS_INCREMENT_SCRIPT,
      2,
      hitKey,
      blockKey,
      String(ttl),
      String(limit),
      String(blockDuration),
    ) as Array<number | string>;

    if (!Array.isArray(raw) || raw.length !== 4) {
      throw new TypeError('Redis throttler returned an invalid response.');
    }

    const [hits, expiresInMs, blocked, blockExpiresInMs] = raw.map(Number);
    if (![hits, expiresInMs, blocked, blockExpiresInMs].every(Number.isFinite)) {
      throw new TypeError('Redis throttler returned non-numeric counters.');
    }

    return {
      totalHits: hits,
      timeToExpire: Math.max(0, Math.ceil(expiresInMs / 1000)),
      isBlocked: blocked === 1,
      timeToBlockExpire: Math.max(0, Math.ceil(blockExpiresInMs / 1000)),
    };
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis.status === 'ready') {
      await this.redis.quit();
    } else {
      this.redis.disconnect();
    }
  }
}

@Module({})
class DeviceEnrollmentThrottleStorageModule {
  static register(redisUrl: string | null): DynamicModule {
    return {
      module: DeviceEnrollmentThrottleStorageModule,
      providers: [
        {
          provide: DEVICE_ENROLLMENT_THROTTLER_STORAGE,
          useFactory: async (): Promise<ThrottlerStorageRedisService | undefined> => {
            if (!redisUrl) return undefined;
            const storage = new ThrottlerStorageRedisService(redisUrl);
            await storage.connect();
            return storage;
          },
        },
      ],
      exports: [DEVICE_ENROLLMENT_THROTTLER_STORAGE],
    };
  }
}

const ENROLLMENT_THROTTLERS = [
  { name: 'enrollMinute', ttl: 60_000, limit: 5, blockDuration: 60_000 },
  { name: 'enrollHour', ttl: 3_600_000, limit: 20, blockDuration: 3_600_000 },
] as const;

/**
 * Use a shared Redis store when REDIS_URL is configured; otherwise use the
 * built-in in-memory store for local development and isolated tests.
 * Pass null explicitly in tests to force the in-memory path.
 */
export function createDeviceEnrollmentThrottleModule(
  redisUrl: string | null = process.env.REDIS_URL?.trim() || null,
): DynamicModule {
  const storageModule = DeviceEnrollmentThrottleStorageModule.register(redisUrl);
  return ThrottlerModule.forRootAsync({
    imports: [storageModule],
    inject: [DEVICE_ENROLLMENT_THROTTLER_STORAGE],
    useFactory: (storage?: ThrottlerStorageRedisService) => ({
      throttlers: [...ENROLLMENT_THROTTLERS],
      ...(storage ? { storage } : {}),
      errorMessage: 'Trop de tentatives d’enrôlement. Réessayez plus tard.',
    }),
  });
}
