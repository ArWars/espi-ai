// golden-set.mjs — ESPI regression harness (FIX-TEST)
// Runs pure functions against real Firestore comparables, measures price MAE
// vs external reference, and asserts cross-field invariants.
// Usage (inside dev container): node test/golden-set.mjs
import {
    querySimilarVehicles, calculateMarketStats, interpretPoliceOrders,
    calculateESPIScore, riskFromScore, calculatePrice, getConfidenceLevel,
} from "../lambda-espi-unified.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const ref = JSON.parse(readFileSync(join(__dir, "reference-data.json"), "utf8"));

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
    if (cond) { pass++; console.log(`  PASS  ${name} ${detail}`); }
    else { fail++; console.log(`  FAIL  ${name} ${detail}`); }
};

// ── Invariant checks reused across cases ──
function assertInvariants(prefix, { score, transferible, priceResult, negotiationPrice, maxPrice }) {
    const rv = riskFromScore(score, transferible);
    // INV-1: score <=5 or intransferible => critical / NO COMPRAR
    if (!transferible || score <= 5) {
        check(`${prefix} INV score<=5||intransf => critical`, rv.risk_level === "critical" && rv.verdict === "NO COMPRAR", `(${rv.risk_level}/${rv.verdict})`);
    }
    // INV-2: risk/verdict never contradict score bands
    const bandOk =
        (rv.risk_level === "low" && score >= 70 && transferible) ||
        (rv.risk_level === "medium" && score >= 40 && score < 70 && transferible) ||
        (rv.risk_level === "high" && score >= 5 && score < 40 && transferible) ||
        (rv.risk_level === "critical");
    check(`${prefix} INV risk band coherent`, bandOk, `(score=${score} -> ${rv.risk_level})`);
    // INV-3: intransferible => valor_transferible 0 but valor_limpio kept
    if (!transferible && priceResult && !priceResult.noData) {
        check(`${prefix} INV intransf => transferible=0 & limpio>0`, priceResult.valor_transferible === 0 && priceResult.valor_limpio > 0);
    }
    // INV-4: confidence Baja => no point price (negotiation/max null)
    if (priceResult && priceResult.confidence === "Baja") {
        check(`${prefix} INV conf Baja => no point price`, negotiationPrice === null && maxPrice === null);
    }
}

(async () => {
    console.log("=== ESPI GOLDEN-SET REGRESSION ===\n");
    for (const c of ref.cases) {
        console.log(`--- CASE ${c.id} ---`);
        const comps = await querySimilarVehicles({ brand: c.brand, model: c.model, year: c.year });
        check(`${c.id} comparables found`, comps.length >= 1, `(${comps.length})`);
        if (!comps.length) { console.log(); continue; }

        const stats = calculateMarketStats(comps);
        const police = c.police === "encargo"
            ? interpretPoliceOrders([{ info: "mantiene encargo por robo" }])
            : interpretPoliceOrders([{ info: "no registra encargo" }]);
        const mileage = { lastKnown: { km: c.mileage_km } };
        const priceResult = calculatePrice({ marketStats: stats, vehicle: {}, mileageAnalysis: mileage, policeStatus: police, auctionAnalysis: { hasAuction: false } });

        const sb = calculateESPIScore({
            realFines: { municipals: { total: 0 }, highways: { total: 0 } },
            techReview: { status: "vigente" }, policeStatus: police,
            mileageAnalysis: { suspicious: false }, auctionAnalysis: { hasAuction: false },
            commercialUse: { isCommercial: false }, vehicleData: { vehicle: { year: c.year } },
        });
        const transferible = !police.description.includes("CON ENCARGO");
        const allowPoint = priceResult.valor_limpio && priceResult.confidence !== "Baja";
        const negotiationPrice = allowPoint ? Math.round(priceResult.valor_limpio * 0.95) : null;
        const maxPrice = allowPoint ? priceResult.valor_limpio : null;

        console.log(`  comparables=${comps.length} conf=${priceResult.confidence} score=${sb.total} valor_limpio=$${priceResult.valor_limpio?.toLocaleString()}`);

        // MAE vs reference
        if (c.ref_price && priceResult.valor_limpio) {
            const err = Math.abs(priceResult.valor_limpio - c.ref_price) / c.ref_price * 100;
            check(`${c.id} MAE < ${ref.mae_threshold_pct}%`, err < ref.mae_threshold_pct, `(${err.toFixed(1)}% vs ref $${c.ref_price.toLocaleString()})`);
        }
        assertInvariants(c.id, { score: sb.total, transferible, priceResult, negotiationPrice, maxPrice });
        console.log();
    }

    // ── Synthetic invariant cases (no Firestore needed) ──
    console.log("--- SYNTHETIC INVARIANTS ---");
    check("conf <3 => Baja", getConfidenceLevel(2) === "Baja");
    const lowConf = calculatePrice({ marketStats: { count: 2, prices: { trimmedMean: 10e6, median: 10e6, min: 9e6, max: 11e6 }, mileage: { average: 30000 } }, vehicle: {}, mileageAnalysis: { lastKnown: { km: 30000 } }, policeStatus: { description: "Sin encargo" }, auctionAnalysis: { hasAuction: false } });
    const allowLP = lowConf.valor_limpio && lowConf.confidence !== "Baja";
    check("conf Baja => point price suppressed", (allowLP ? lowConf.valor_limpio : null) === null, `(conf=${lowConf.confidence})`);
    assertInvariants("synthetic-encargo", { score: 5, transferible: false, priceResult: { valor_limpio: 17e6, valor_transferible: 0, noData: false, confidence: "Alta" }, negotiationPrice: 16e6, maxPrice: 17e6 });

    console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
    process.exit(fail ? 1 : 0);
})();
