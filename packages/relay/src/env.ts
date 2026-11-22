// Relay configured from the environment (Vercel / self-hosting): REDIS_URL (or KV_URL), RELAY_KEY_PREFIX, RELAY_HOST.
// Production fails closed: no in-memory store, no Host-header signing host, no empty key prefix.
import { createRelay, type Relay } from './server.ts';
import { RedisStore } from './redis-store.ts';
import { MemoryStore } from './store.ts';

export const isProductionEnv = (env: NodeJS.ProcessEnv): boolean => env.VERCEL === '1' || env.NODE_ENV === 'production';

export function relayFromEnv(env: NodeJS.ProcessEnv = process.env): Relay {
  const url = env.REDIS_URL || env.KV_URL;
  if (isProductionEnv(env)) {
    const missing = [!url && 'REDIS_URL', !env.RELAY_HOST && 'RELAY_HOST', !env.RELAY_KEY_PREFIX && 'RELAY_KEY_PREFIX'].filter(Boolean);
    if (missing.length) throw new Error(`relay: refusing to start in production without ${missing.join(', ')}`);
  }
  const store = url ? new RedisStore(url, `relay-${Math.random().toString(36).slice(2, 8)}`) : new MemoryStore();
  return createRelay({
    store,
    ...(env.RELAY_HOST ? { host: env.RELAY_HOST } : {}),
    keyPrefix: env.RELAY_KEY_PREFIX ?? '',
    ...(env.RELAY_QUEUE_EXPIRY_MS ? { queueExpiryMs: Number(env.RELAY_QUEUE_EXPIRY_MS) } : {}),
    log: (event, meta) => { if (event.endsWith('_error') || event === 'heartbeat_dead') console.error(JSON.stringify({ event, ...meta })); },
  });
}
