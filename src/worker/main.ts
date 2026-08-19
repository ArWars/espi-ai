// ─────────────────────────────────────────────────────────────────────────────
// worker/main.ts — Worker BullMQ del informe ESPI
//
// Cada réplica Cloud Run corre este proceso. WORKER_CONCURRENCY jobs en
// paralelo por réplica; múltiples réplicas consumen la misma cola (competencia
// natural de BullMQ: cada job lo toma exactamente un worker).
// ─────────────────────────────────────────────────────────────────────────────
import { Worker } from 'bullmq';
import { loadConfig } from '../config.ts';
import { getSharedRedis } from '../queue/connection.ts';
import { ESPI_QUEUE_NAME, resultKey, statusKey, JOB_RESULT_TTL_SECONDS } from '../queue/jobs.ts';
import { ReportService } from '../reportService.ts';
import { MarketRepository } from '../market/repository.ts';
import { LlmRouter } from '../llm/router.ts';
import { GeminiProvider } from '../llm/gemini.ts';
import { OpenAICompatProvider } from '../llm/openaiCompat.ts';
import type { EspiJobPayload } from '../types.ts';

const config = loadConfig();
const redis = getSharedRedis(config);
const cacheRedis = getSharedRedis(config); // misma conexión para cache (db 3)

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
        // Sin LLM configurado: igualmente instanciar router con template fallback
        return new LlmRouter([new GeminiProvider({ model: config.llm.geminiModel })]);
    }
    return new LlmRouter(providers);
}

const market = new MarketRepository({
    projectId: config.gcp.projectId,
    collection: config.gcp.firestoreCollection,
    cache: cacheRedis,
    ttlSeconds: config.market.cacheTtlSeconds,
    prefix: config.redis.prefix,
});

const service = new ReportService({ market, llm: buildLlmRouter(), config });

const concurrency = Math.max(1, config.worker.concurrency);
console.log(`[worker] starting — queue=${ESPI_QUEUE_NAME} concurrency=${concurrency} db=${config.redis.db}`);

const worker = new Worker<EspiJobPayload>(
    ESPI_QUEUE_NAME,
    async (job) => {
        const { job_id, report_type, vehicle_data } = job.data;
        console.log(`[worker] job ${job_id} start (${report_type}/${vehicle_data.vehicle.plate})`);
        try {
            await redis.set(statusKey(job_id), JSON.stringify({ status: 'processing' }), 'EX', JOB_RESULT_TTL_SECONDS);
            const result = await service.generate({ vehicleData: vehicle_data, reportType: report_type, jobId: job_id });
            await redis.set(resultKey(job_id), JSON.stringify(result), 'EX', JOB_RESULT_TTL_SECONDS);
            await redis.set(statusKey(job_id), JSON.stringify({ status: 'completed' }), 'EX', JOB_RESULT_TTL_SECONDS);
            console.log(`[worker] job ${job_id} completed`);
            return result;
        } catch (err) {
            const msg = (err as Error).message;
            console.error(`[worker] job ${job_id} failed:`, msg);
            await redis.set(statusKey(job_id), JSON.stringify({ status: 'failed', failed_reason: msg }), 'EX', JOB_RESULT_TTL_SECONDS);
            throw err;
        }
    },
    {
        connection: redis.duplicate(),
        concurrency,
        // Cloud Run: el job de un informe puede tardar (LLM + Firestore)
        lockDuration: 120_000,
        stalledInterval: 90_000,
        maxStalledCount: 2,
    }
);

worker.on('completed', (job) => {
    console.log(`[worker] bullmq completed ${job.id}`);
});
worker.on('failed', (job, err) => {
    console.error(`[worker] bullmq failed ${job?.id}:`, err.message);
});
worker.on('error', (err) => {
    console.error('[worker] worker error:', err.message);
});

// Graceful shutdown (Cloud Run manda SIGTERM al hacer scale-down)
const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} received — closing`);
    await worker.close();
    redis.disconnect();
    process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
