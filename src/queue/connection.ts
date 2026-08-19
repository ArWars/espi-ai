// ─────────────────────────────────────────────────────────────────────────────
// queue/connection.ts — Conexión Redis compartida para BullMQ
//
// Reutiliza la MISMA instancia Redis que splecCore (10.1.0.4) con una DB
// distinta (db 3 por defecto; splecCore usa db 2). Así no hay una segunda
// instancia que mantener y las keys quedan aisladas por SELECT.
// ─────────────────────────────────────────────────────────────────────────────
import IORedis, { type Redis } from 'ioredis';
import type { EspiConfig } from '../config.ts';

let shared: Redis | null = null;

export function getSharedRedis(config: EspiConfig): Redis {
    if (shared) return shared;
    shared = new IORedis({
        host: config.redis.host,
        port: config.redis.port,
        ...(config.redis.password && { password: config.redis.password }),
        db: config.redis.db,
        // Workers requieren maxRetriesPerRequest: null (reintentos infinitos)
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        connectTimeout: 10_000,
        keepAlive: 30_000,
        lazyConnect: false,
    });
    shared.on('error', (err: Error) => {
        const msg = err?.message || String(err);
        if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|closed|reconnect/i.test(msg)) {
            // Drops transitorios: ioredis reconecta solo
            console.warn('[redis] transient drop (reconnecting):', msg);
            return;
        }
        console.error('[redis] error:', msg);
    });
    return shared;
}

/** Caché de comparables — conexión con maxRetriesPerRequest limitado (API). */
export function getCacheRedis(config: EspiConfig): Redis {
    return new IORedis({
        host: config.redis.host,
        port: config.redis.port,
        ...(config.redis.password && { password: config.redis.password }),
        db: config.redis.db,
        maxRetriesPerRequest: 2,
        enableReadyCheck: false,
        connectTimeout: 10_000,
        keepAlive: 30_000,
        lazyConnect: true,
    });
}

export async function closeRedis(): Promise<void> {
    if (shared) {
        await shared.quit().catch(() => undefined);
        shared = null;
    }
}
