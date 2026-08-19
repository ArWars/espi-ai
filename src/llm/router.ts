// ─────────────────────────────────────────────────────────────────────────────
// llm/router.ts — Router de proveedores LLM con fallback en cascada
//
// Orden (configurable por env): proveedor primario → secundarios → template
// determinista. Si todo falla, el informe se genera con datos duros y se marca
// `degraded: true` — el sistema NUNCA queda sin responder un job.
// ─────────────────────────────────────────────────────────────────────────────
import type { EspiReport } from '../types.ts';
import type { LlmProvider, LlmRequest } from './provider.ts';
import { extractJsonObject } from './provider.ts';
import { buildTemplateReport, type TemplateInput } from './template.ts';

export interface RouterReportResult {
    report: EspiReport;
    degraded: boolean;
    provider: string;
    model: string;
    usage: { tokens_input: number; tokens_output: number };
}

export class LlmRouter {
    private providers: LlmProvider[];

    constructor(providers: LlmProvider[]) {
        if (providers.length === 0) throw new Error('LlmRouter requires at least one provider');
        this.providers = providers;
    }

    /** Genera el informe: LLM (con coerción determinista) o template fallback. */
    async generateReport(req: LlmRequest, templateInput: TemplateInput): Promise<RouterReportResult> {
        let lastError: Error | null = null;

        for (const provider of this.providers) {
            try {
                const res = await provider.call(req);
                const parsed = extractJsonObject(res.text);
                if (parsed && typeof parsed === 'object' && 'summary' in parsed && 'espi_score' in parsed) {
                    return {
                        report: coerceReport(parsed as Record<string, unknown>, templateInput),
                        degraded: false,
                        provider: res.provider,
                        model: res.model,
                        usage: res.usage,
                    };
                }
                lastError = new Error(`${provider.name}: response missing required fields`);
            } catch (err) {
                lastError = err as Error;
                console.warn(`[llm-router] ${provider.name} failed: ${(err as Error).message}`);
            }
        }

        // Todos los LLM fallaron → template determinista
        console.warn(`[llm-router] all providers failed (${lastError?.message}) — generating template report`);
        return {
            report: buildTemplateReport(templateInput),
            degraded: true,
            provider: 'template',
            model: 'deterministic-template',
            usage: { tokens_input: 0, tokens_output: 0 },
        };
    }
}

/**
 * Coerción defensiva: los campos numéricos read-only del informe se reemplazan
 * SIEMPRE por los valores deterministas (score, precios, confianza, riesgo).
 * El LLM solo aporta narrativa — jamás puede "recalcular" una cifra.
 */
function coerceReport(raw: Record<string, unknown>, t: TemplateInput): EspiReport {
    const report = raw as unknown as EspiReport;
    const lowConfidence = t.price.confidence === 'Baja';

    if (report.espi_score) report.espi_score.total = t.score.total;
    if (report.summary) report.summary.risk_level = t.risk.risk_level;
    if (report.price_analysis) {
        report.price_analysis.market_base = t.price.base ?? null;
        report.price_analysis.adjustments = t.price.adjustments.map((a) => ({
            concept: a.concept, percentage: a.percentage, amount: a.amount, reason: a.reason,
        }));
        report.price_analysis.valor_limpio = lowConfidence ? null : t.price.valor_limpio;
        report.price_analysis.valor_transferible = t.price.valor_transferible ?? 0;
        report.price_analysis.estimated_value = t.price.transferible ? t.price.valor_transferible : null;
        report.price_analysis.confidence = t.price.confidence;
        if (!report.price_analysis.explanation) {
            report.price_analysis.explanation = 'Valores deterministas calculados sobre comparables de mercado.';
        }
    }
    if (report._buyer) {
        report._buyer.negotiation_price = t.negotiationPrice;
        report._buyer.max_price = t.maxPrice;
    }
    return report;
}
export { buildTemplateReport };
