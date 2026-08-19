// ─────────────────────────────────────────────────────────────────────────────
// worker/worker.ts — Lógica desacoplada del worker BullMQ
// ─────────────────────────────────────────────────────────────────────────────
import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { EspiConfig } from '../config.ts';
import type { ReportService } from '../reportService.ts';
import { ESPI_QUEUE_NAME, resultKey, statusKey, JOB_RESULT_TTL_SECONDS } from '../queue/jobs.ts';
import type { EspiJobPayload } from '../types.ts';

export function startWorker(opts: { config: EspiConfig; redis: Redis; service: ReportService }): Worker<EspiJobPayload> {
    const { config, redis, service } = opts;
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

    return worker;
}
