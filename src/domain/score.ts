// ─────────────────────────────────────────────────────────────────────────────
// domain/score.ts — Score ESPI (8 factores + caps)
// Puerto 1:1 de calculateESPIScore() del lambda legacy (FIX-2, FIX-DOMINIO).
// ─────────────────────────────────────────────────────────────────────────────
import type {
    AuctionAnalysis,
    CommercialUseAnalysis,
    DomainLimitations,
    MileageAnalysis,
    PoliceStatus,
    RealFines,
    RntStatus,
    ScoreBreakdown,
    TechnicalReview,
    VehicleData,
} from '../types.ts';

interface ScoreInput {
    realFines: RealFines;
    techReview: TechnicalReview | null | undefined;
    policeStatus: PoliceStatus;
    mileageAnalysis: MileageAnalysis;
    auctionAnalysis: AuctionAnalysis;
    commercialUse: CommercialUseAnalysis;
    vehicleData: VehicleData;
    domainLimitations: DomainLimitations;
    rntStatus?: RntStatus;
}

export function calculateESPIScore(input: ScoreInput): ScoreBreakdown {
    const { realFines, techReview, policeStatus, mileageAnalysis, auctionAnalysis, commercialUse, vehicleData, domainLimitations, rntStatus } = input;
    let score = 100;
    const breakdown: ScoreBreakdown = { base: 100 } as ScoreBreakdown;

    // Período de homologación
    const vehicleYear = parseInt(String(vehicleData?.vehicle?.year)) || 0;
    const vehicleAge = Math.max(0, new Date().getFullYear() - vehicleYear);
    const inHomologation = vehicleAge <= 2;

    // 1. RT — no penalizar si está en homologación
    breakdown.technical_review = 0;
    if (!inHomologation && techReview?.status?.toLowerCase().includes('vencid')) {
        breakdown.technical_review = -25;
        score -= 25;
    }

    // 2. Multas municipales
    breakdown.municipal_fines = 0;
    if (realFines.municipals.total > 10_000_000) {
        breakdown.municipal_fines = -50;
    } else if (realFines.municipals.total > 1_000_000) {
        breakdown.municipal_fines = -30;
    } else if (realFines.municipals.total > 100_000) {
        breakdown.municipal_fines = -15;
    } else if (realFines.municipals.total > 0) {
        breakdown.municipal_fines = -5;
    }
    score += breakdown.municipal_fines;

    // 3. Autopistas
    breakdown.highway_fines = 0;
    if (realFines.highways.total > 50_000) {
        breakdown.highway_fines = -10;
    } else if (realFines.highways.total > 0) {
        breakdown.highway_fines = -5;
    }
    score += breakdown.highway_fines;

    // 4. Encargo policial
    breakdown.police_orders = parseInt(policeStatus.penalty) || 0;
    score += breakdown.police_orders;

    // 5. Documentación
    breakdown.documentation = 0;
    if (vehicleData.soap_status?.status === 'NO VIGENTE') {
        breakdown.documentation -= 10;
    }
    // Permiso de circulación atrasado (dinámico)
    const currentYear = new Date().getFullYear();
    const permitYear = vehicleData.circulation_permit?.payment_year;
    if (permitYear) {
        const yearMatch = permitYear.match(/(\d{4})/);
        if (yearMatch) {
            const yearsLate = currentYear - parseInt(yearMatch[1]);
            if (yearsLate >= 3) {
                breakdown.documentation -= 20;
            } else if (yearsLate >= 2) {
                breakdown.documentation -= 15;
            } else if (yearsLate >= 1) {
                breakdown.documentation -= 10;
            }
        }
    }
    score += breakdown.documentation;

    // 6. Kilometraje — no penalizar si está en homologación
    breakdown.mileage = 0;
    if (!inHomologation) {
        // 6a. Penalización por status global (promedio km/año)
        let statusPenalty = 0;
        if (mileageAnalysis.rollbackDetected) {
            statusPenalty = -25;
        } else if (mileageAnalysis.status === 'ADULTERACIÓN DETECTADA') {
            statusPenalty = -25;
        } else if (mileageAnalysis.status === 'ALTO') {
            statusPenalty = -15;
        } else if (mileageAnalysis.status === 'MEDIO-ALTO') {
            statusPenalty = -8;
        } else if (mileageAnalysis.status === 'SOSPECHOSAMENTE BAJO') {
            statusPenalty = -10;
        }

        // 6b. Penalización por anomalías de SEGMENTO: el promedio global puede
        // enmascarar un período de uso intensivo.
        const intensiveSegments = (mileageAnalysis.segments || []).filter(
            (s) => s.anomaly === 'Uso extremadamente intensivo'
        ).length;
        let segmentPenalty = 0;
        if (intensiveSegments >= 3) {
            segmentPenalty = -15;
        } else if (intensiveSegments === 2) {
            segmentPenalty = -12;
        } else if (intensiveSegments === 1) {
            segmentPenalty = -8;
        }
        breakdown.mileage_intensive_segments = intensiveSegments;

        // La penalización más severa (no sumar — evitar doble conteo)
        breakdown.mileage = Math.min(statusPenalty, segmentPenalty);
    }
    score += breakdown.mileage;

    // 7. Remate/siniestro
    breakdown.auction = 0;
    if (auctionAnalysis.hasAuction) {
        breakdown.auction = -30;
        score += breakdown.auction;
    }

    // 8. Uso comercial
    breakdown.commercial_use = 0;
    if (commercialUse?.flagged) {
        if (commercialUse.finesPerYear >= 20) {
            breakdown.commercial_use = -20;
        } else if (commercialUse.finesPerYear >= 10) {
            breakdown.commercial_use = -15;
        } else {
            breakdown.commercial_use = -10;
        }
        score += breakdown.commercial_use;
    }

    // 9. Transporte público confirmado vía RNT (registro oficial MTT).
    // Registro positivo = uso comercial de FUENTE OFICIAL (no heurística de
    // multas). Penalización mayor que la heurística; no se suma con ella
    // (una misma realidad —uso comercial— se cuenta una sola vez): rige la
    // penalización más severa.
    breakdown.rnt_public_transport = 0;
    if (rntStatus?.confirmedCommercialUse) {
        const rntPenalty = rntStatus.credentialsActive ? -18 : -12;
        breakdown.rnt_public_transport = rntPenalty;
        if (breakdown.commercial_use > rntPenalty) {
            // La heurística ya descontó: revertir y dejar solo la penal RNT
            score -= breakdown.commercial_use;
            breakdown.commercial_use = 0;
        }
        score += breakdown.rnt_public_transport;
    }

    // FIX-2: cap score at 5 if CON ENCARGO
    if (policeStatus.description && policeStatus.description.includes('CON ENCARGO')) {
        score = Math.min(score, 5);
        breakdown.police_cap = true;
    }

    // FIX-DOMINIO: cap score at 40 si hay cualquier limitación al dominio inscrita
    if (domainLimitations && domainLimitations.hasBlocking) {
        score = Math.min(score, 40);
        breakdown.domain_limitation_cap = true;
        breakdown.domain_limitations = domainLimitations.items;
    }
    if (domainLimitations && domainLimitations.pending && domainLimitations.pending.length > 0) {
        breakdown.domain_pending = domainLimitations.pending;
    }

    breakdown.total = Math.max(0, Math.min(100, score));
    return breakdown;
}
