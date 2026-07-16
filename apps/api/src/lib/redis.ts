import { Redis } from "ioredis";
import { env } from "../env.js";

let base: Redis | null = null;

/** Shared connection for commands (not for subscriptions). */
export function redis(): Redis {
  if (!base) {
    base = new Redis(env().REDIS_URL, {
      maxRetriesPerRequest: 3,
      lazyConnect: false,
    });
  }
  return base;
}

/** Dedicated connection for pub/sub subscribers. */
export function redisSubscriber(): Redis {
  return new Redis(env().REDIS_URL, { maxRetriesPerRequest: 3 });
}

export async function closeRedis(): Promise<void> {
  if (base) {
    await base.quit().catch(() => base?.disconnect());
    base = null;
  }
}
