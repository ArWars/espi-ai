// ─────────────────────────────────────────────────────────────────────────────
// domain/price.ts — Tasación determinista (FIX-4+5+6+7 del legacy)
// Puerto 1:1 de calculatePrice() + getConfidenceLevel() del lambda.
// ─────────────────────────────────────────────────────────────────────────────
import type {
    AuctionAnalysis,
    DomainLimitations,
    MarketStats,
    MileageAnalysis,
    PoliceStatus,
    PriceConfidence,
    PriceResult,
    RntStatus,
} from '../types.ts';
import { RNT_COMMERCIAL_DISCOUNT_PCT } from './rnt.ts';

/** Confianza según cantidad de comparables (≥8 Alta · ≥3 Media · <3 Baja). */
export function getConfidenceLevel(count: number): PriceConfidence {
    if (count >= 8) return 'Alta';
    if (count >= 3) return 'Media';
    return 'Baja';
}

export function calculatePrice(input: {
    marketStats: MarketStats | null;
    vehicle: unknown;
    mileageAnalysis: Pick<MileageAnalysis, 'lastKnown'>;
    policeStatus: PoliceStatus;
    auctionAnalysis: AuctionAnalysis;
    domainLimitations?: DomainLimitations | null;
    rntStatus?: RntStatus | null;
}): PriceResult {
    const { marketStats, mileageAnalysis, policeStatus, auctionAnalysis, domainLimitations, rntStatus } = input;

    if (!marketStats) {
        return { base: null, adjustments: [], valor_limpio: null, valor_transferible: null, transferible: false, confidence: 'Baja', noData: true };
    }

    const confidence = getConfidenceLevel(marketStats.count);
    const base = marketStats.prices.trimmedMean ?? marketStats.prices.median;
    const adjustments: PriceResult['adjustments'] = [];

    // Ajuste por kilometraje vs promedio de comparables — PROPORCIONAL al
    // exceso/déficit (alto km penaliza 15% del exceso, tope -30%; bajo km
    // premia 10%, tope +10%). Solo si difiere >15% del promedio.
    if (mileageAnalysis.lastKnown?.km && marketStats.mileage?.average) {
        const kmDiff = mileageAnalysis.lastKnown.km - marketStats.mileage.average;
        const kmPct = kmDiff / marketStats.mileage.average;
        if (Math.abs(kmPct) > 0.15) {
            const pct = kmPct > 0
                ? -Math.min(kmPct * 0.15, 0.30)
                : Math.min(-kmPct * 0.10, 0.10);
            const amount = Math.round(base * pct);
            adjustments.push({
                concept: 'Kilometraje',
                percentage: (pct * 100).toFixed(1) + '%',
                amount,
                reason: kmPct > 0
                    ? `Km ~${Math.round(kmPct * 100)}% sobre el promedio de comparables`
                    : `Km ~${Math.round(-kmPct * 100)}% bajo el promedio de comparables`,
            });
        }
    }

    // Ajuste por remate/siniestro
    if (auctionAnalysis?.hasAuction) {
        const amount = Math.round(base * -0.2);
        adjustments.push({ concept: 'Historial remate/siniestro', percentage: '-20%', amount, reason: 'Vehículo con historial de remate o pérdida total' });
    }

    // Ajuste por uso comercial CONFIRMADO vía RNT (registro oficial MTT).
    // Vehículo inscrito para transporte público/escolar: desgaste mayor al
    // que el km sugiere, mercado de reventa más estrecho y exigencias
    // normativas propias (RT de transporte público). Descuento fijo -10%.
    if (rntStatus?.confirmedCommercialUse) {
        const amount = Math.round(base * -RNT_COMMERCIAL_DISCOUNT_PCT);
        const service = rntStatus.serviceType ? ` (${rntStatus.serviceType})` : '';
        adjustments.push({
            concept: 'Uso comercial confirmado (RNT)',
            percentage: `-${Math.round(RNT_COMMERCIAL_DISCOUNT_PCT * 100)}%`,
            amount,
            reason: `Vehículo registrado en el RNT para transporte público/escolar${service} — desgaste y mercado de reventa particulares`,
        });
    }

    const valor_limpio = Math.round(base + adjustments.reduce((s, a) => s + a.amount, 0));

    // Estado legal: encargo policial O limitación al dominio = intransferible
    const domainBlocks = domainLimitations ? domainLimitations.hasBlocking : false;
    const transferible = !policeStatus.description.includes('CON ENCARGO') && !domainBlocks;
    const valor_transferible = transferible ? valor_limpio : 0;

    return { base, adjustments, valor_limpio, valor_transferible, transferible, confidence };
}

/**
 * Precio de negociación (95%) y máximo — SOLO si hay precio puntual permitido:
 * confianza ≠ Baja Y transferible. En caso contrario null (el LLM no debe
 * inventar precios puntuales cuando no hay datos o el auto es intransferible).
 */
export function negotiationPrices(priceResult: PriceResult): { negotiationPrice: number | null; maxPrice: number | null } {
    const allowPointPrice = priceResult.valor_limpio && priceResult.confidence !== 'Baja' && priceResult.transferible;
    return {
        negotiationPrice: allowPointPrice ? Math.round(priceResult.valor_limpio! * 0.95) : null,
        maxPrice: allowPointPrice ? priceResult.valor_limpio : null,
    };
}
