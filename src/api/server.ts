// ─────────────────────────────────────────────────────────────────────────────
// api/server.ts — API HTTP de espi-ai (Hono)
//
// Endpoints:
//   GET  /health              — liveness/readiness
//   POST /espi                — informe sincrónico (compatible con legacy)
//   POST /jobs                — encola informe async → { job_id }
//   GET  /jobs/:id            — estado + resultado del job
//
// El sync expone exactamente el response shape del legacy ({ success, data: { report, raw_data, metadata } }).
// ─────────────────────────────────────────────────────────────────────────────
import { Hono } from 'hono';
import type { EspiConfig } from '../config.ts';
import { REPORT_TYPES, type ReportType, type VehicleData } from '../types.ts';
import { ReportService } from '../reportService.ts';
import type { QueueModule } from '../queue/jobs.ts';

export function createApp(opts: { config: EspiConfig; service: ReportService; queue: QueueModule }): Hono {
    const { config, service, queue } = opts;

    const app = new Hono();

    // ── CORS (compatible con legacy: allow-origin *) ──────────────────────
    app.use('*', async (c, next) => {
        await next();
        c.header('Access-Control-Allow-Origin', '*');
        c.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
        c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    });
    app.options('*', (c) => c.body(null, 204));

    // ── Auth (si API_TOKEN está seteado) ──────────────────────────────────
    const requireAuth = async (c: any, next: () => Promise<void>) => {
        if (!config.apiToken) return next();
        const auth = c.req.header('Authorization') || '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : c.req.header('X-Api-Token') || '';
        if (token !== config.apiToken) {
            return c.json({ success: false, error: 'Unauthorized' }, 401);
        }
        return next();
    };

    // ── Health ────────────────────────────────────────────────────────────
    app.get('/health', (c) =>
        c.json({
            status: 'ok',
            version: 'v3-ts',
            queue: 'espi-reports',
            ts: new Date().toISOString(),
        })
    );

    // ── POST /espi — sincrónico (compat legacy) ───────────────────────────
    app.post('/espi', requireAuth, async (c) => {
        let body: Record<string, unknown>;
        try {
            body = await c.req.json();
        } catch {
            return c.json({ success: false, error: 'Invalid JSON body' }, 400);
        }

        const vehicleData = (body.vehicleData || body) as VehicleData;
        const reportType = (body.report_type || vehicleData.report_type || 'buyer') as ReportType;

        if (!vehicleData?.vehicle?.plate) {
            return c.json({ success: false, error: 'Vehicle data with plate is required' }, 400);
        }
        if (!REPORT_TYPES.includes(reportType)) {
            return c.json({ success: false, error: `Invalid report_type. Must be one of: ${REPORT_TYPES.join(', ')}` }, 400);
        }

        try {
            const result = await service.generate({ vehicleData, reportType, jobId: `sync-${crypto.randomUUID()}` });
            return c.json({
                success: true,
                data: {
                    report: result.report,
                    raw_data: result.raw_data,
                    metadata: result.metadata,
                },
            });
        } catch (err) {
            console.error('[api] sync report failed:', err);
            return c.json({ success: false, error: { message: 'Error generating report', detail: (err as Error).message } }, 500);
        }
    });

    // ── POST /jobs — async ────────────────────────────────────────────────
    app.post('/jobs', requireAuth, async (c) => {
        let body: Record<string, unknown>;
        try {
            body = await c.req.json();
        } catch {
            return c.json({ success: false, error: 'Invalid JSON body' }, 400);
        }

        const vehicleData = (body.vehicleData || body) as VehicleData;
        const reportType = (body.report_type || vehicleData.report_type || 'buyer') as ReportType;

        if (!vehicleData?.vehicle?.plate) {
            return c.json({ success: false, error: 'Vehicle data with plate is required' }, 400);
        }
        if (!REPORT_TYPES.includes(reportType)) {
            return c.json({ success: false, error: `Invalid report_type. Must be one of: ${REPORT_TYPES.join(', ')}` }, 400);
        }

        const { job_id } = await queue.enqueue({ vehicleData, reportType });
        return c.json({ success: true, job_id, status_url: `/jobs/${job_id}` }, 202);
    });

    // ── GET /jobs/:id — poll de resultado ─────────────────────────────────
    app.get('/jobs/:id', requireAuth, async (c) => {
        const id = c.req.param('id');
        const result = await queue.readResult(id);
        if (result) {
            return c.json({ success: true, status: 'completed', data: result });
        }
        const status = await queue.readStatus(id);
        if (status) {
            return c.json({ success: true, ...status });
        }
        return c.json({ success: false, error: 'Job not found' }, 404);
    });

    return app;
}
