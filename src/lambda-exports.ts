// ─────────────────────────────────────────────────────────────────────────────
// lambda-exports.ts — Exposición de funciones puras para el golden-set
// (equivalente a los TEST EXPORTS del lambda legacy, sin instanciar Firestore)
// ─────────────────────────────────────────────────────────────────────────────
import { calculateMarketStats } from './market/marketStats.ts';
import { interpretDomainLimitations } from './domain/domainLimitations.ts';
import { calculatePrice } from './domain/price.ts';
import { interpretPoliceOrders } from './domain/police.ts';
import { calculateESPIScore } from './domain/score.ts';
import { riskFromScore } from './domain/risk.ts';
import { getConfidenceLevel } from './domain/price.ts';
import { MarketRepository } from './market/repository.ts';
import type IORedis from 'ioredis';

// querySimilarVehicles contra Firestore real, instancia fresh (golden-set)
let repo: MarketRepository | null = null;
export async function querySimilarVehicles(q: { brand: string; model: string; year: string | number }) {
    if (!repo) {
        repo = new MarketRepository({
            projectId: process.env.GCP_PROJECT_ID || 'espi-ia-491115',
            collection: process.env.FIRESTORE_COLLECTION || 'chileautos_vehiculos',
            cache: null,
        });
    }
    return repo.querySimilarVehicles(q);
}

export {
    calculateMarketStats,
    interpretPoliceOrders,
    interpretDomainLimitations,
    calculateESPIScore,
    riskFromScore,
    calculatePrice,
    getConfidenceLevel,
};
