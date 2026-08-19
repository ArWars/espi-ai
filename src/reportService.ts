// ─────────────────────────────────────────────────────────────────────────────
// reportService.ts — Orquestador del informe ESPI
// Equivalente al handler del lambda legacy, modular y testeable.
// Pipeline: market → domain → prompts → LLM (con fallback) → reporte.
// ─────────────────────────────────────────────────────────────────────────────
import type {
    ComparableListing,
    EspiJobResult,
    MarketStats,
    ReportType,
    VehicleData,
} from './types.ts';
import { calculateRealFines } from './domain/fines.ts';
import { interpretPoliceOrders } from './domain/police.ts';
import { interpretDomainLimitations } from './domain/domainLimitations.ts';
import { analyzeOwnershipConsistency } from './domain/ownership.ts';
import { analyzeMileageHistory } from './domain/mileage.ts';
import { analyzeCommercialUse } from './domain/commercialUse.ts';
import { analyzeAuctions } from './domain/auctions.ts';
import { analyzeRnt } from './domain/rnt.ts';
import { calculateESPIScore } from './domain/score.ts';
import { riskFromScore } from './domain/risk.ts';
import { calculatePrice, negotiationPrices } from './domain/price.ts';
import { calculateMarketStats } from './market/marketStats.ts';
import type { MarketRepository } from './market/repository.ts';
import { buildSystemPrompt, buildUserPrompt } from './llm/prompts.ts';
import type { LlmRouter } from './llm/router.ts';
import type { TemplateInput } from './llm/template.ts';
import type { EspiConfig } from './config.ts';

export interface GenerateReportInput {
    vehicleData: VehicleData;
    reportType: ReportType;
    jobId?: string;
}

export class ReportService {
    private market: MarketRepository;
    private llm: LlmRouter;
    private config: EspiConfig;

    constructor(opts: { market: MarketRepository; llm: LlmRouter; config: EspiConfig }) {
        const { market, llm, config } = opts;
        this.market = market;
        this.llm = llm;
        this.config = config;
    }

    async generate(input: GenerateReportInput): Promise<EspiJobResult> {
        const startTime = Date.now();
        const { vehicleData, reportType, jobId } = input;
        const plate = vehicleData.vehicle.plate;

        // ── 1. Comparables de mercado ────────────────────────────────
        let comparables: ComparableListing[] = [];
        let marketStats: MarketStats | null = null;
        try {
            comparables = await this.market.querySimilarVehicles({
                brand: vehicleData.vehicle.brand,
                model: vehicleData.vehicle.model,
                year: vehicleData.vehicle.year,
            });
            if (comparables.length > 0) {
                marketStats = calculateMarketStats(comparables);
            }
        } catch (err) {
            console.error(`[${plate}] market query failed:`, (err as Error).message);
        }

        // ── 2. Cálculos deterministas ────────────────────────────────
        const realFines = calculateRealFines(vehicleData.fines);
        const policeStatus = interpretPoliceOrders(vehicleData.police_orders);
        const techReview = vehicleData.technical_review?.[0];
        const mileageAnalysis = analyzeMileageHistory(vehicleData.technical_review, vehicleData.vehicle);
        const auctionAnalysis = analyzeAuctions(vehicleData.auctions);
        const commercialUse = analyzeCommercialUse(vehicleData.fines);
        const rntStatus = analyzeRnt(vehicleData.rnt);
        const ownershipConsistency = analyzeOwnershipConsistency(vehicleData);
        const domainLimitations = interpretDomainLimitations(vehicleData);
        const scoreBreakdown = calculateESPIScore({
            realFines,
            techReview,
            policeStatus,
            mileageAnalysis,
            auctionAnalysis,
            commercialUse,
            vehicleData,
            domainLimitations,
            rntStatus,
        });

        const transferible = !policeStatus.description.includes('CON ENCARGO') && domainLimitations.transferible;
        const risk = riskFromScore(scoreBreakdown.total, transferible);

        const priceResult = calculatePrice({
            marketStats,
            vehicle: vehicleData.vehicle,
            mileageAnalysis,
            policeStatus,
            auctionAnalysis,
            domainLimitations,
            rntStatus,
        });
        const { negotiationPrice, maxPrice } = negotiationPrices(priceResult);

        // ── 3. Prompts ───────────────────────────────────────────────
        const templateInput: TemplateInput = {
            vehicle: vehicleData.vehicle,
            reportType,
            score: scoreBreakdown,
            risk,
            price: priceResult,
            negotiationPrice,
            maxPrice,
            realFines,
            policeStatus,
            techReview,
            mileage: mileageAnalysis,
            auctions: auctionAnalysis,
            commercialUse,
            domainLimitations,
            ownership: ownershipConsistency,
            marketStats,
            rnt: rntStatus,
        };

        const systemPrompt = buildSystemPrompt();
        const userPrompt = buildUserPrompt({
            vehicleData,
            realFines,
            policeStatus,
            techReview,
            mileageAnalysis,
            auctionAnalysis,
            commercialUse,
            scoreBreakdown,
            marketStats,
            comparables,
            reportType,
            riskLabel: risk.risk_level,
            verdictLabel: risk.verdict,
            priceResult,
            negotiationPrice,
            maxPrice,
            domainLimitations,
            ownershipConsistency,
            rntStatus,
        } as Parameters<typeof buildUserPrompt>[0]);

        // ── 4. LLM con fallback ──────────────────────────────────────
        const llmResult = await this.llm.generateReport(
            { systemPrompt, userPrompt, temperature: 0.15 },
            templateInput
        );

        const processingTime = Date.now() - startTime;
        console.log(`[${plate}] report ${llmResult.degraded ? '(DEGRADED-template)' : llmResult.provider} in ${processingTime}ms | tokens ${llmResult.usage.tokens_input}/${llmResult.usage.tokens_output}`);

        return {
            job_id: jobId || plate,
            status: 'completed',
            report: llmResult.report,
            raw_data: {
                comparables: comparables.slice(0, 10),
                market_stats: marketStats,
                score_breakdown: scoreBreakdown,
                fines_detail: realFines,
                mileage_analysis: mileageAnalysis,
                auction_analysis: auctionAnalysis,
                police_status: policeStatus,
                commercial_use: commercialUse,
                rnt_status: rntStatus,
                domain_limitations: domainLimitations,
                ownership_consistency: ownershipConsistency,
            },
            metadata: {
                timestamp: new Date().toISOString(),
                report_type: reportType,
                model: llmResult.model,
                tokens_input: llmResult.usage.tokens_input,
                tokens_output: llmResult.usage.tokens_output,
                processing_time_ms: processingTime,
                vehicle_plate: plate,
                comparables_found: comparables.length,
                version: 'v1.4-ts',
                job_id: jobId,
            },
        };
    }
}
