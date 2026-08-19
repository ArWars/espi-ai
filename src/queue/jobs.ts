// ─────────────────────────────────────────────────────────────────────────────
// queue/jobs.ts — Cola BullMQ de informes ESPI
//
// Multi-réplica: cualquier API puede encolar; cualquier worker (en cualquier
// réplica Cloud Run) toma el job. Resultados persistidos en Redis con TTL,
// consultables vía GET /jobs/:id sin acoplarse a qué réplica lo procesó.
// ─────────────────────────────────────────────────────────────────────────────
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { EspiJobPayload, EspiJobResult, ReportType, VehicleData } from '../types.ts';

export const ESPI_QUEUE_NAME = 'espi-reports';
export const JOB_RESULT_TTL_SECONDS = 3600; // 1h para recoger resultado

export interface QueueModule {
    queue: Queue<EspiJobPayload>;
    enqueue(opts: { vehicleData: VehicleData; reportType: ReportType }): Promise<{ job_id: string }>;
    readResult(jobId: string): Promise<EspiJobResult | null>;
    readStatus(jobId: string): Promise<{ status: string; failed_reason?: string } | null>;
}

export const resultKey = (jobId: string): string => `espi:job:result:${jobId}`;
export const statusKey = (jobId: string): string => `espi:job:status:${jobId}`;

export function createQueueModule(sharedRedis: Redis): QueueModule {
    const queue = new Queue<EspiJobPayload>(ESPI_QUEUE_NAME, {
        connection: sharedRedis.duplicate(),
        defaultJobOptions: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
            removeOnComplete: { age: 3600, count: 1000 },
            removeOnFail: { age: 7200, count: 5000 },
        },
    });

    return {
        queue,
        async enqueue({ vehicleData, reportType }) {
            const job_id = crypto.randomUUID();
            const payload: EspiJobPayload = {
                job_id,
                report_type: reportType,
                vehicle_data: vehicleData,
                created_at: new Date().toISOString(),
            };
            await queue.add('espi-report', payload, { jobId: job_id });
            return { job_id };
        },
        async readResult(jobId) {
            const raw = await sharedRedis.get(resultKey(jobId));
            if (!raw) return null;
            try {
                return JSON.parse(raw) as EspiJobResult;
            } catch {
                return null;
            }
        },
        async readStatus(jobId) {
            const raw = await sharedRedis.get(statusKey(jobId));
            if (!raw) return null;
            try {
                return JSON.parse(raw) as { status: string; failed_reason?: string };
            } catch {
                return null;
            }
        },
    };
}
