// ─────────────────────────────────────────────────────────────────────────────
// config.ts — Configuración central por environment variables
// ─────────────────────────────────────────────────────────────────────────────

export interface EspiConfig {
    port: number;
    apiToken: string | null;
    llm: {
        provider: 'gemini' | 'openai-compat' | 'auto';
        geminiApiKey: string;
        geminiModel: string;
        openaiCompatBaseUrl: string;
        openaiCompatApiKey: string;
        openaiCompatModel: string;
        vertexai: boolean;
        gcpProject: string;
        gcpLocation: string;
    };
    gcp: {
        projectId: string;
        location: string;
        firestoreCollection: string;
    };
    redis: {
        host: string;
        port: number;
        password: string;
        db: number;
        prefix: string;
    };
    worker: {
        concurrency: number;
        maxRetries: number;
    };
    market: {
        cacheTtlSeconds: number;
    };
}

function int(name: string, def: number): number {
    const v = parseInt(process.env[name] || '');
    return Number.isFinite(v) ? v : def;
}

export function loadConfig(): EspiConfig {
    return {
        port: int('PORT', 8080),
        apiToken: process.env.API_TOKEN || null,
        llm: {
            provider: (process.env.LLM_PROVIDER as EspiConfig['llm']['provider']) || 'gemini',
            geminiApiKey: process.env.GEMINI_API_KEY || '',
            geminiModel: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
            openaiCompatBaseUrl: process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
            openaiCompatApiKey: process.env.LLM_API_KEY || '',
            openaiCompatModel: process.env.LLM_CHAT_MODEL || 'gpt-4o-mini',
            vertexai: process.env.GEMINI_VERTEXAI === 'true',
            gcpProject: process.env.GCP_PROJECT_ID || 'espi-ia-491115',
            gcpLocation: process.env.GCP_LOCATION || 'us-central1',
        },
        gcp: {
            projectId: process.env.GCP_PROJECT_ID || 'espi-ia-491115',
            location: process.env.GCP_LOCATION || 'us-central1',
            firestoreCollection: process.env.FIRESTORE_COLLECTION || 'chileautos_vehiculos',
        },
        redis: {
            host: process.env.REDIS_HOST || 'localhost',
            port: int('REDIS_PORT', 6379),
            password: process.env.REDIS_PASSWORD || '',
            db: int('ESPI_REDIS_DB', 3),
            prefix: process.env.ESPI_REDIS_PREFIX || 'espi',
        },
        worker: {
            concurrency: int('WORKER_CONCURRENCY', 4),
            maxRetries: int('WORKER_MAX_RETRIES', 2),
        },
        market: {
            cacheTtlSeconds: int('MARKET_CACHE_TTL_SECONDS', 21600),
        },
    };
}
