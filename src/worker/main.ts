// ─────────────────────────────────────────────────────────────────────────────
// worker/main.ts — Entrypoint standalone para worker BullMQ (opcional)
// ─────────────────────────────────────────────────────────────────────────────
import { loadConfig } from '../config.ts';
import { getSharedRedis } from '../queue/connection.ts';
import { ReportService } from '../reportService.ts';
import { MarketRepository } from '../market/repository.ts';
import { LlmRouter } from '../llm/router.ts';
import { GeminiProvider } from '../llm/gemini.ts';
import { OpenAICompatProvider } from '../llm/openaiCompat.ts';
import { startWorker } from './worker.ts';

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
const worker = startWorker({ config, redis, service });

const port = parseInt(process.env.PORT || '8080', 10);
Bun.serve({
    port,
    fetch() {
        return new Response(JSON.stringify({ status: 'ok', role: 'standalone-worker' }), {
            headers: { 'content-type': 'application/json' },
        });
    },
});

const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} received — closing`);
    await worker.close();
    redis.disconnect();
    process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
