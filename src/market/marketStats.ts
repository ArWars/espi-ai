// ─────────────────────────────────────────────────────────────────────────────
// market/marketStats.ts — Estadísticas de mercado sobre comparables
// Puerto 1:1 de calculateMarketStats() del lambda legacy.
// ─────────────────────────────────────────────────────────────────────────────
import type { ComparableListing, MarketStats } from '../types.ts';

export function calculateMarketStats(vehicles: ComparableListing[]): MarketStats | null {
    if (!vehicles?.length) return null;

    const prices = vehicles.map((v) => v.precio_clp).filter((p) => p > 0).sort((a, b) => a - b);
    if (!prices.length) return null;

    const sum = prices.reduce((a, b) => a + b, 0);
    const avg = sum / prices.length;
    const median = prices[Math.floor(prices.length / 2)];
    const variance = prices.reduce((s, p) => s + Math.pow(p - avg, 2), 0) / prices.length;
    const stdDev = Math.sqrt(variance);

    // Trimmed mean (excluir min y max si hay 5+)
    let trimmedMean = avg;
    if (prices.length >= 5) {
        const trimmed = prices.slice(1, -1);
        trimmedMean = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
    }

    // Kilometraje promedio (puede venir como string "108.100 km")
    const parseKm = (k: unknown): number | null => {
        if (typeof k === 'number') return k > 0 ? k : null;
        if (typeof k === 'string') {
            const n = parseInt(k.replace(/[^\d]/g, ''), 10);
            return Number.isFinite(n) && n > 0 ? n : null;
        }
        return null;
    };
    const mileages = vehicles.map((v) => parseKm(v.kilometraje)).filter((k): k is number => k != null);
    const avgMileage = mileages.length > 0 ? mileages.reduce((a, b) => a + b, 0) / mileages.length : null;

    return {
        count: prices.length,
        prices: {
            min: prices[0],
            max: prices[prices.length - 1],
            avg: Math.round(avg),
            median: Math.round(median),
            trimmedMean: Math.round(trimmedMean),
            stdDev: Math.round(stdDev),
        },
        mileage: { average: avgMileage ? Math.round(avgMileage) : null },
    };
}
