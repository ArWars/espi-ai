// ─────────────────────────────────────────────────────────────────────────────
// index.ts — Entrypoint del servicio API de espi-ai
// Arranca el HTTP server (Hono) con el servicio de informes y la cola.
// (El worker es un proceso aparte: src/worker/main.ts)
// ─────────────────────────────────────────────────────────────────────────────
import { loadConfig } from './config.ts';
import { createApp } from './api/server.ts';
import { ReportService } from './reportService.ts';
import { MarketRepository } from './market/repository.ts';
import { LlmRouter } from './llm/router.ts';
import { GeminiProvider } from './llm/gemini.ts';
import { OpenAICompatProvider } from './llm/openaiCompat.ts';
import { getSharedRedis } from './queue/connection.ts';
import { createQueueModule } from './queue/jobs.ts';

const config = loadConfig();
const redis = getSharedRedis(config);

function buildLlmRouter(): LlmRouter {
    const providers = [];
    if (config.llm.provider === 'gemini' || config.llm.provider === 'auto') {
        providers.push(new GeminiProvider({
            apiKey: config.llm.geminiApiKey,
            model: config.llm.geminiModel,
            project: config.llm.gcpProject,
            location: config.llm.gcpLocation,
            vertexai: config.llm.vertexai,
        }));
    }
    if (config.llm.provider === 'openai-compat' || config.llm.provider === 'auto') {
        if (config.llm.openaiCompatApiKey) {
            providers.push(new OpenAICompatProvider({
                baseUrl: config.llm.openaiCompatBaseUrl,
                apiKey: config.llm.openaiCompatApiKey,
                model: config.llm.openaiCompatModel,
            }));
        }
    }
    if (providers.length === 0) {
        return new LlmRouter([new GeminiProvider({ model: config.llm.geminiModel })]);
    }
    return new LlmRouter(providers);
}

const market = new MarketRepository({
    projectId: config.gcp.projectId,
    collection: config.gcp.firestoreCollection,
    cache: redis,
    ttlSeconds: config.market.cacheTtlSeconds,
    prefix: config.redis.prefix,
});

const service = new ReportService({ market, llm: buildLlmRouter(), config });
const queue = createQueueModule(redis);
const app = createApp({ config, service, queue });

const port = config.port;
console.log(`[api] espi-ai v1.3-ts listening on :${port} | llm=${config.llm.provider} | redis db=${config.redis.db}`);

export default {
    port,
    fetch: app.fetch,
};
