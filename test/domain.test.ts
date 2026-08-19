// ─────────────────────────────────────────────────────────────────────────────
// test/domain.test.ts — Tests unitarios de las funciones deterministas
// (puerto de las invariantes del golden-set legacy + casos sintéticos)
// ─────────────────────────────────────────────────────────────────────────────
import { describe, expect, test } from 'bun:test';
import { calculateRealFines } from '../src/domain/fines.ts';
import { interpretPoliceOrders } from '../src/domain/police.ts';
import { interpretDomainLimitations } from '../src/domain/domainLimitations.ts';
import { analyzeOwnershipConsistency } from '../src/domain/ownership.ts';
import { analyzeMileageHistory } from '../src/domain/mileage.ts';
import { analyzeCommercialUse } from '../src/domain/commercialUse.ts';
import { analyzeAuctions } from '../src/domain/auctions.ts';
import { calculateESPIScore } from '../src/domain/score.ts';
import { riskFromScore } from '../src/domain/risk.ts';
import { calculatePrice, getConfidenceLevel, negotiationPrices } from '../src/domain/price.ts';
import { calculateMarketStats } from '../src/market/marketStats.ts';
import { matchesTargetModel, splitModelVersion } from '../src/market/matching.ts';
import type { VehicleData } from '../src/types.ts';

// ── Vehículo base para tests ─────────────────────────────────────────────────
const baseVehicle: VehicleData = {
    vehicle: { plate: 'TEST01', brand: 'TOYOTA', model: 'Corolla', year: '2020' },
    technical_review: null,
    police_orders: [],
    fines: null,
    auctions: null,
    soap_status: null,
    circulation_permit: null,
    cav: null,
};

describe('fines', () => {
    test('vacío → ceros', () => {
        const r = calculateRealFines(null);
        expect(r.totalDebt).toBe(0);
        expect(r.highways.count).toBe(0);
    });

    test('autopistas no pagadas suman, pagadas no', () => {
        const r = calculateRealFines({
            highways: {
                'RUTA 68': [
                    { total_ballot: '15000', paid: 'NO PAGADA' },
                    { total_ballot: '20000', paid: 'PAGADA' },
                ],
            },
        });
        expect(r.highways.count).toBe(2);
        expect(r.highways.total).toBe(15000);
        expect(r.highways.unpaid).toBe(1);
        expect(r.highways.paid).toBe(1);
    });

    test('municipales estimadas cuando no hay montos reales', () => {
        const r = calculateRealFines({
            municipalities: {},
            externals: [
                { type: 'new', description: 'Exceso velocidad 2024' },
                { type: 'new', description: 'Exceso velocidad 2024' }, // dup — estimar única
                { type: 'old', description: 'Estacionamiento 2019' },
            ],
        });
        expect(r.municipals.source).toBe('estimated');
        expect(r.municipals.count).toBe(1); // descripción única
        expect(r.municipals.total).toBe(73265);
    });
});

describe('police', () => {
    test('sin órdenes → Estado no verificado', () => {
        expect(interpretPoliceOrders([]).description).toBe('Estado no verificado');
    });
    test('no registra encargo → limpio', () => {
        expect(interpretPoliceOrders([{ info: 'NO REGISTRA ENCARGO' }]).description).toBe('Sin encargo policial vigente');
    });
    test('mantiene encargo → CAP', () => {
        const s = interpretPoliceOrders([{ info: 'MANTIENE ENCARGO POR ROBO' }]);
        expect(s.description).toBe('CON ENCARGO POLICIAL VIGENTE');
        expect(s.penalty).toBe('CAP');
    });
});

describe('domain limitations', () => {
    test('sin CAV → sin limitaciones, transferible', () => {
        const r = interpretDomainLimitations({ vehicle: baseVehicle.vehicle });
        expect(r.hasBlocking).toBe(false);
        expect(r.transferible).toBe(true);
    });
    test('embargo → bloqueante, no transferible', () => {
        const r = interpretDomainLimitations({
            vehicle: baseVehicle.vehicle,
            cav: { annotations: [{ category: 'limitation', nature: 'EMBARGO' }] },
        });
        expect(r.hasBlocking).toBe(true);
        expect(r.transferible).toBe(false);
        expect(r.items[0]).toContain('EMBARGO');
    });
    test('flags planos también bloquean', () => {
        const r = interpretDomainLimitations({
            vehicle: baseVehicle.vehicle,
            has_prohibitions: true,
        });
        expect(r.hasBlocking).toBe(true);
        expect(r.items[0]).toContain('prohibición de enajenar');
    });
    test('anotación en trámite → pending, no bloqueante', () => {
        const r = interpretDomainLimitations({
            vehicle: baseVehicle.vehicle,
            cav: { annotations: [{ category: 'annotation', nature: 'Anotación', annotation_date: null }] },
        });
        expect(r.hasBlocking).toBe(false);
        expect(r.pending.length).toBe(1);
    });
});

describe('ownership consistency', () => {
    test('sin datos → sin mismatch', () => {
        expect(analyzeOwnershipConsistency(baseVehicle).hasMismatch).toBe(false);
    });
    test('SOAP de tercero → mismatch', () => {
        const r = analyzeOwnershipConsistency({
            ...baseVehicle,
            cav: { current_owner: { nombre: 'JUAN PEREZ', rut: '12.345.678-9' } },
            soap_status: { certificate: { owner_name: 'PEDRO SOTO', owner_rut: '98.765.432-1' } },
        });
        expect(r.hasMismatch).toBe(true);
        expect(r.soapOwner?.name).toBe('PEDRO SOTO');
    });
    test('mismo RUT normalizado → sin mismatch', () => {
        const r = analyzeOwnershipConsistency({
            ...baseVehicle,
            cav: { current_owner: { nombre: 'Juan Perez', rut: '12345678-9' } },
            soap_status: { certificate: { owner_name: 'JUAN PEREZ', owner_rut: '12.345.678-9' } },
        });
        expect(r.hasMismatch).toBe(false);
    });
});

describe('mileage (LNDS)', () => {
    const veh = (year: string) => ({ plate: 'X', brand: 'B', model: 'M', year });
    const rt = (date: string, km: number | null) => ({
        status: 'APROBADO',
        revision: { inspection_date: date, mileage: km },
        plant: { plant_name: 'P' },
    });

    test('retroceso sostenido → rollback detectado', () => {
        // La serie cae y NUNCA recupera: LNDS backbone = [90000, 95000],
        // las lecturas posteriores quedan fuera sin recuperación → rollback.
        const r = analyzeMileageHistory(
            [rt('2019-01-01', 90000), rt('2020-01-01', 95000), rt('2021-01-01', 60000), rt('2022-01-01', 62000)],
            veh('2018')
        );
        expect(r.rollbackDetected).toBe(true);
        expect(r.status).toBe('ADULTERACIÓN DETECTADA');
    });

    test('caída aislada → error de digitación, no rollback', () => {
        const r = analyzeMileageHistory(
            [rt('2019-01-01', 50000), rt('2020-01-01', 15000), rt('2021-01-01', 85000)],
            veh('2018')
        );
        expect(r.rollbackDetected).toBe(false);
        expect(r.dataEntryErrorsFiltered).toBe(1);
    });

    test('km repetido 3+ → PTR no confiable + estimado', () => {
        const r = analyzeMileageHistory(
            [rt('2019-01-01', 60000), rt('2020-01-01', 60000), rt('2021-01-01', 60000), rt('2022-01-01', 61000)],
            veh('2018')
        );
        expect(r.repeatedKmDetected).toBe(true);
        expect(r.estimatedRealKm).toBeGreaterThan(0);
        expect(r.status).toBe('DATO NO CONFIABLE — PTR repite km');
    });

    test('vehículo en homologación (≤2 años) sin km', () => {
        const r = analyzeMileageHistory([], veh(String(new Date().getFullYear() - 1)));
        expect(r.status).toBe('HOMOLOGACIÓN VIGENTE');
        expect(r.estimatedRealKm).toBeGreaterThan(0);
    });

    test('uso normal → NORMAL', () => {
        const r = analyzeMileageHistory(
            [rt('2019-01-01', 10000), rt('2020-01-01', 25000), rt('2021-01-01', 40000)],
            veh('2018')
        );
        expect(r.status).toBe('NORMAL');
        expect(r.avgKmPerYear).toBeGreaterThan(10000);
    });
});

describe('commercial use', () => {
    test('sin multas → no flagged', () => {
        expect(analyzeCommercialUse(null).flagged).toBe(false);
    });
    test('dispersión alta → flagged confianza alta', () => {
        // 60 multas JPL en un único año (2023) y 12 comunas → 60/año, 12 comunas
        const externals = Array.from({ length: 60 }, (_, i) => ({
            type: 'new',
            description: `Multa 2023-${i}`,
            court: { name: `${i % 12} JPL COMUNA${i % 12}` },
        }));
        const r = analyzeCommercialUse({ externals });
        expect(r.flagged).toBe(true);
        expect(r.confidence).toBe('alta');
        expect(r.uniqueMunicipalities).toBe(12);
    });
});

describe('auctions', () => {
    test('remate detectado', () => {
        const r = analyzeAuctions([{ type: 'REMATE', company: 'XYZ', operation: 'REMATE VEHICULO', date: '2023-05-01' }]);
        expect(r.hasAuction).toBe(true);
        expect(r.company).toBe('XYZ');
    });
    test('sin remates', () => {
        expect(analyzeAuctions([]).hasAuction).toBe(false);
        expect(analyzeAuctions([{ operation: 'COMPRA' }]).hasAuction).toBe(false);
    });
});

describe('score', () => {
    const cleanCtx = (overrides: Partial<Parameters<typeof calculateESPIScore>[0]> = {}) => ({
        realFines: calculateRealFines(null),
        techReview: { status: 'VIGENTE' },
        policeStatus: interpretPoliceOrders([]),
        mileageAnalysis: analyzeMileageHistory([], { plate: 'X', brand: 'B', model: 'M', year: '2015' }),
        auctionAnalysis: { hasAuction: false },
        commercialUse: { flagged: false } as any,
        vehicleData: { ...baseVehicle, vehicle: { ...baseVehicle.vehicle, year: '2015' } },
        domainLimitations: interpretDomainLimitations(baseVehicle),
        ...overrides,
    });

    test('vehículo limpio antiguo → score alto', () => {
        const sb = calculateESPIScore(cleanCtx());
        expect(sb.total).toBeGreaterThanOrEqual(70);
    });

    test('encargo policial → cap en 5', () => {
        const sb = calculateESPIScore(cleanCtx({
            policeStatus: { description: 'CON ENCARGO POLICIAL VIGENTE', penalty: 'CAP' },
        }));
        expect(sb.total).toBeLessThanOrEqual(5);
        expect(sb.police_cap).toBe(true);
    });

    test('limitación dominio → cap en 40', () => {
        const sb = calculateESPIScore(cleanCtx({
            domainLimitations: {
                ...interpretDomainLimitations(baseVehicle),
                hasBlocking: true,
                items: ['EMBARGO'],
            },
        }));
        expect(sb.total).toBeLessThanOrEqual(40);
        expect(sb.domain_limitation_cap).toBe(true);
    });

    test('multas municipales escalonadas', () => {
        const mk = (total: number) => calculateESPIScore(cleanCtx({
            realFines: {
                highways: { total: 0, count: 0, unpaid: 0, paid: 0 },
                municipals: { total, count: 1, source: 'real' },
                externals: { count: 0, total: 0 },
                totalDebt: total,
            },
        }));
        expect(mk(50_000).municipal_fines).toBe(-5);
        expect(mk(500_000).municipal_fines).toBe(-15);
        expect(mk(5_000_000).municipal_fines).toBe(-30);
        expect(mk(50_000_000).municipal_fines).toBe(-50);
    });
});

describe('risk bands', () => {
    test('intransferible → critical / NO COMPRAR', () => {
        const rv = riskFromScore(90, false);
        expect(rv.risk_level).toBe('critical');
        expect(rv.verdict).toBe('NO COMPRAR');
    });
    test('bandas 5/40/70', () => {
        expect(riskFromScore(5, true).risk_level).toBe('critical');
        expect(riskFromScore(39, true).risk_level).toBe('high');
        expect(riskFromScore(69, true).risk_level).toBe('medium');
        expect(riskFromScore(70, true).risk_level).toBe('low');
    });
});

describe('price', () => {
    const marketStats = {
        count: 10,
        prices: { min: 8_000_000, max: 12_000_000, avg: 10_000_000, median: 10_000_000, trimmedMean: 10_000_000, stdDev: 500_000 },
        mileage: { average: 50_000 },
    };
    const cleanPolice = { description: 'Sin encargo policial vigente', penalty: '0' };
    const noAuction = { hasAuction: false };

    test('confianza por count', () => {
        expect(getConfidenceLevel(2)).toBe('Baja');
        expect(getConfidenceLevel(3)).toBe('Media');
        expect(getConfidenceLevel(8)).toBe('Alta');
    });

    test('km sobre promedio → ajuste proporcional negativo', () => {
        const r = calculatePrice({
            marketStats: marketStats as any,
            vehicle: {},
            mileageAnalysis: { lastKnown: { km: 100_000, date: '2024-01-01' } } as any,
            policeStatus: cleanPolice,
            auctionAnalysis: noAuction,
        });
        expect(r.base).toBe(10_000_000);
        expect(r.adjustments.length).toBe(1);
        expect(r.adjustments[0].amount).toBeLessThan(0);
        expect(r.valor_limpio).toBeLessThan(10_000_000);
        expect(r.confidence).toBe('Alta');
        expect(r.transferible).toBe(true);
    });

    test('km igual al promedio → sin ajuste', () => {
        const r = calculatePrice({
            marketStats: marketStats as any,
            vehicle: {},
            mileageAnalysis: { lastKnown: { km: 50_000, date: '2024-01-01' } } as any,
            policeStatus: cleanPolice,
            auctionAnalysis: noAuction,
        });
        expect(r.adjustments.length).toBe(0);
        expect(r.valor_limpio).toBe(10_000_000);
    });

    test('remate → -20%', () => {
        const r = calculatePrice({
            marketStats: marketStats as any,
            vehicle: {},
            mileageAnalysis: { lastKnown: { km: 50_000, date: '2024-01-01' } } as any,
            policeStatus: cleanPolice,
            auctionAnalysis: { hasAuction: true } as any,
        });
        expect(r.adjustments[0].percentage).toBe('-20%');
        expect(r.valor_limpio).toBe(8_000_000);
    });

    test('intransferible → valor_transferible 0, limpio intacto', () => {
        const r = calculatePrice({
            marketStats: marketStats as any,
            vehicle: {},
            mileageAnalysis: { lastKnown: { km: 50_000, date: '2024-01-01' } } as any,
            policeStatus: { description: 'CON ENCARGO POLICIAL VIGENTE', penalty: 'CAP' },
            auctionAnalysis: noAuction,
        });
        expect(r.transferible).toBe(false);
        expect(r.valor_transferible).toBe(0);
        expect(r.valor_limpio).toBe(10_000_000);
    });

    test('negotiationPrices: Baja o intransferible → null', () => {
        const lowConf = calculatePrice({
            marketStats: { ...marketStats, count: 2 } as any,
            vehicle: {},
            mileageAnalysis: { lastKnown: { km: 50_000, date: '2024-01-01' } } as any,
            policeStatus: cleanPolice,
            auctionAnalysis: noAuction,
        });
        expect(lowConf.confidence).toBe('Baja');
        const np = negotiationPrices(lowConf);
        expect(np.negotiationPrice).toBeNull();
        expect(np.maxPrice).toBeNull();
    });
});

describe('marketStats', () => {
    test('stats de comparables sintéticos', () => {
        const comps = [5, 10, 10, 10, 15, 20].map((p) => ({ precio_clp: p * 1_000_000, kilometraje: '50.000 km' }));
        const s = calculateMarketStats(comps as any)!;
        expect(s.count).toBe(6);
        expect(s.prices.min).toBe(5_000_000);
        expect(s.prices.max).toBe(20_000_000);
        expect(s.mileage.average).toBe(50_000);
    });
    test('vacío → null', () => {
        expect(calculateMarketStats([])).toBeNull();
    });
});

describe('matching', () => {
    test('split versión', () => {
        const { modelBase, targetVersion } = splitModelVersion('Corolla SE AUTOMATICO');
        expect(modelBase).toBe('Corolla');
        expect(targetVersion).toBe('se');
    });
    test('guard modelo corto', () => {
        // El guard exige PREFIJO: "2" calza con target "2active", no con "mazda2"
        expect(matchesTargetModel('2', '2active')).toBe(true);
        expect(matchesTargetModel('2', 'mazda2')).toBe(false);
    });
    test('fuzzy leve', () => {
        expect(matchesTargetModel('corolla', 'corolla')).toBe(true);
        expect(matchesTargetModel('corola', 'corolla')).toBe(true); // levenshtein 1
    });
});
