// ─────────────────────────────────────────────────────────────────────────────
// test/golden-set.ts — Regresión golden-set contra Firestore real (opcional)
//
// Puerto del test/golden-set.mjs legacy. Requiere credenciales GCP y red.
// Correr con: bun run test/golden-set.ts   (se salta si no hay creds)
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { querySimilarVehicles, calculateMarketStats, interpretPoliceOrders, calculateESPIScore, riskFromScore, calculatePrice, interpretDomainLimitations } from '../src/lambda-exports.ts';
import type { Redis } from 'ioredis';

const __dir = dirname(fileURLToPath(import.meta.url));
const ref = JSON.parse(readFileSync(join(__dir, 'reference-data.json'), 'utf8'));

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail = '') => {
    if (cond) { pass++; console.log(`  PASS  ${name} ${detail}`); }
    else { fail++; console.log(`  FAIL  ${name} ${detail}`); }
};

function assertInvariants(prefix: string, o: { score: number; transferible: boolean; priceResult: any; negotiationPrice: number | null; maxPrice: number | null }) {
    const rv = riskFromScore(o.score, o.transferible);
    if (!o.transferible || o.score <= 5) {
        check(`${prefix} INV score<=5||intransf => critical`, rv.risk_level === 'critical' && rv.verdict === 'NO COMPRAR', `(${rv.risk_level}/${rv.verdict})`);
    }
    const bandOk =
        (rv.risk_level === 'low' && o.score >= 70 && o.transferible) ||
        (rv.risk_level === 'medium' && o.score >= 40 && o.score < 70 && o.transferible) ||
        (rv.risk_level === 'high' && o.score >= 5 && o.score < 40 && o.transferible) ||
        rv.risk_level === 'critical';
    check(`${prefix} INV risk band coherent`, bandOk, `(score=${o.score} -> ${rv.risk_level})`);
    if (!o.transferible && o.priceResult && !o.priceResult.noData) {
        check(`${prefix} INV intransf => transferible=0 & limpio>0`, o.priceResult.valor_transferible === 0 && o.priceResult.valor_limpio > 0);
    }
    if (o.priceResult && o.priceResult.confidence === 'Baja') {
        check(`${prefix} INV conf Baja => no point price`, o.negotiationPrice === null && o.maxPrice === null);
    }
}

async function main() {
    console.log('=== ESPI GOLDEN-SET REGRESSION (TS) ===\n');
    for (const c of ref.cases) {
        console.log(`--- CASE ${c.id} ---`);
        const comps = await querySimilarVehicles({ brand: c.brand, model: c.model, year: c.year });
        check(`${c.id} comparables found`, comps.length >= 1, `(${comps.length})`);
        if (!comps.length) { console.log(); continue; }

        const stats = calculateMarketStats(comps);
        const police = c.police === 'encargo'
            ? interpretPoliceOrders([{ info: 'mantiene encargo por robo' }])
            : interpretPoliceOrders([{ info: 'no registra encargo' }]);
        const mileage = { lastKnown: { km: c.mileage_km } };
        const priceResult = calculatePrice({ marketStats: stats, vehicle: {}, mileageAnalysis: mileage as any, policeStatus: police, auctionAnalysis: { hasAuction: false } });

        const sb = calculateESPIScore({
            realFines: { municipals: { total: 0 }, highways: { total: 0 } } as any,
            techReview: { status: 'vigente' },
            policeStatus: police,
            mileageAnalysis: { suspicious: false } as any,
            auctionAnalysis: { hasAuction: false },
            commercialUse: { flagged: false } as any,
            vehicleData: { vehicle: { year: c.year } } as any,
            domainLimitations: interpretDomainLimitations({} as any),
        });
        const transferible = !police.description.includes('CON ENCARGO');
        const allowPoint = priceResult.valor_limpio && priceResult.confidence !== 'Baja';
        const negotiationPrice = allowPoint ? Math.round(priceResult.valor_limpio! * 0.95) : null;
        const maxPrice = allowPoint ? priceResult.valor_limpio : null;

        console.log(`  comparables=${comps.length} conf=${priceResult.confidence} score=${sb.total} valor_limpio=$${priceResult.valor_limpio?.toLocaleString()}`);

        if (c.ref_price && priceResult.valor_limpio) {
            const err = Math.abs(priceResult.valor_limpio - c.ref_price) / c.ref_price * 100;
            check(`${c.id} MAE < ${ref.mae_threshold_pct}%`, err < ref.mae_threshold_pct, `(${err.toFixed(1)}% vs ref $${c.ref_price.toLocaleString()})`);
        }
        assertInvariants(c.id, { score: sb.total, transferible, priceResult, negotiationPrice, maxPrice });
        console.log();
    }
    console.log(`=== RESULT: ${pass} passed, ${fail} failed ===`);
    process.exit(fail ? 1 : 0);
}

main().catch((err) => {
    console.error('golden-set failed:', err.message);
    process.exit(1);
});
