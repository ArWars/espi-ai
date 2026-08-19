// ─────────────────────────────────────────────────────────────────────────────
// domain/mileage.ts — Análisis de historial de kilometraje (LNDS)
// Puerto 1:1 de analyzeMileageHistory() + buildOdometerBackbone() del lambda.
// ─────────────────────────────────────────────────────────────────────────────
import type { MileageAnalysis, MileageSegment, TechnicalReview, VehicleCore } from '../types.ts';

export const NORMAL_KM_PER_YEAR = 15000;
export const HOMOLOGATION_YEARS = 2;
export const ESTIMATED_KM_PER_YEAR = 25000;

interface TimelinePoint {
    date: string;
    km: number | null;
    kmOriginal: number | null;
    plant: string;
    status: string;
    certificateNumber?: string | null;
    dataEntryError: boolean;
    dataEntryNote: string | null;
}

/**
 * Longest Non-Decreasing Subsequence (LNDS) — O(n²), n ≤ ~15 RT entries.
 *
 * Devuelve un Set de índices (en `points`) que forman el esqueleto válido más
 * largo del odómetro. Todo punto FUERA del esqueleto es un outlier — error de
 * digitación en planta (caída aislada) o rollback sostenido (manipulación).
 *
 * Tie-break: ante subsecuencias de igual largo, preferir la que termina en el
 * km más alto (un odómetro adulterado se resetea hacia ABAJO; siempre queremos
 * preservar la marca real más alta).
 */
function buildOdometerBackbone(points: TimelinePoint[]): Set<number> {
    const n = points.length;
    if (n === 0) return new Set();

    const dp = Array(n).fill(1);
    const parent = Array(n).fill(-1);

    for (let i = 1; i < n; i++) {
        for (let j = 0; j < i; j++) {
            if (points[j].km! <= points[i].km! && dp[j] + 1 > dp[i]) {
                dp[i] = dp[j] + 1;
                parent[i] = j;
            }
        }
    }

    const maxLen = Math.max(...dp);
    let bestEnd = 0;
    for (let i = 0; i < n; i++) {
        if (dp[i] === maxLen && points[i].km! >= points[bestEnd].km!) bestEnd = i;
    }

    const backbone = new Set<number>();
    let cur = bestEnd;
    while (cur !== -1) {
        backbone.add(cur);
        cur = parent[cur];
    }
    return backbone;
}

export function analyzeMileageHistory(
    technicalReviews: TechnicalReview[] | null | undefined,
    vehicle: VehicleCore
): MileageAnalysis {
    const vehicleYear = parseInt(String(vehicle.year));
    const vehicleAge = Math.max(1, new Date().getFullYear() - vehicleYear);

    // ── Timeline crudo (todas las RT con fecha) ──────────────────────────────
    const timeline: TimelinePoint[] = (technicalReviews || [])
        .filter((tr) => tr?.revision?.inspection_date)
        .map((tr) => {
            const km = tr.revision!.mileage != null ? parseInt(String(tr.revision!.mileage)) : null;
            return {
                date: tr.revision!.inspection_date!,
                km,
                kmOriginal: km,
                plant: tr.plant?.plant_name || 'N/D',
                status: tr.status || tr.revision?.inspection_result || 'N/D',
                certificateNumber: tr.certificateNumber,
                dataEntryError: false,
                dataEntryNote: null,
            };
        })
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    // ── Clasificación de outliers vía LNDS ───────────────────────────────────
    const withKmRaw = timeline.filter((t) => t.km != null && t.km > 0);

    if (withKmRaw.length >= 2) {
        const backbone = buildOdometerBackbone(withKmRaw);

        withKmRaw.forEach((entry, idx) => {
            if (backbone.has(idx)) return; // lectura válida — se mantiene

            const hasPrevValid = [...backbone].some((j) => j < idx);
            const hasNextValid = [...backbone].some((j) => j > idx);

            if (hasPrevValid && hasNextValid) {
                // Caída aislada: una lectura válida posterior recupera el nivel
                // pre-caída. Error clásico de digitación en planta RT.
                const bbSorted = [...backbone].sort((a, b) => a - b);
                const prevEntry = withKmRaw[bbSorted.filter((j) => j < idx).at(-1)!];
                const nextEntry = withKmRaw[bbSorted.find((j) => j > idx)!];
                entry.km = null;
                entry.dataEntryError = true;
                entry.dataEntryNote = `Km original: ${entry.kmOriginal!.toLocaleString()} — ignorado (caída aislada entre ${prevEntry.km!.toLocaleString()} y ${nextEntry.km!.toLocaleString()} km, error de digitación en planta RT)`;
            } else {
                // Sin recuperación: lecturas quedan bajo este punto. Marcado como
                // manipulado pero km visible para que el timeline muestre la caída.
                entry.dataEntryError = false; // no es typo — manipulación deliberada
            }
        });
    }

    const dataEntryErrors = timeline.filter((t) => t.dataEntryError);
    const withKm = timeline.filter((t) => t.km != null && t.km > 0);

    // ── Período de homologación (vehículos nuevos, ≤ 2 años) ─────────────────
    const inHomologationPeriod = vehicleAge <= HOMOLOGATION_YEARS;

    if (withKm.length === 0) {
        const base = {
            lastKnown: null,
            avgKmPerYear: null,
            timeline,
            segments: [] as MileageSegment[],
            rollbackDetected: false,
            repeatedKmDetected: false,
            totalReviews: timeline.length,
            reviewsWithKm: 0,
            dataEntryErrorsFiltered: dataEntryErrors.length,
        };
        if (inHomologationPeriod) {
            const estKm = vehicleAge * ESTIMATED_KM_PER_YEAR;
            return {
                ...base,
                firstKnown: null,
                estimatedRealKm: estKm,
                estimatedNote: `Vehículo ${vehicleYear} con homologación vigente (${HOMOLOGATION_YEARS} años sin RT obligatoria). Km estimado: ~${estKm.toLocaleString()} km`,
                status: 'HOMOLOGACIÓN VIGENTE',
                inHomologationPeriod: true,
            };
        }
        return {
            ...base,
            firstKnown: null,
            estimatedRealKm: null,
            estimatedNote: null,
            status: 'NO DISPONIBLE — sin registro de km en RT',
            inHomologationPeriod: false,
        };
    }

    const lastKnown = withKm[withKm.length - 1];
    const firstKnown = withKm[0];

    // km/año: preferir el span entre primera y última lectura válida; fallback
    // al span desde año de fabricación cuando hay un solo dato.
    const yearsToLast = withKm.length >= 2
        ? Math.max(0.5, (new Date(lastKnown.date).getTime() - new Date(firstKnown.date).getTime()) / (1000 * 60 * 60 * 24 * 365))
        : Math.max(0.5, new Date(lastKnown.date).getFullYear() - vehicleYear);
    const avgKmPerYear = withKm.length >= 2
        ? (lastKnown.km! - firstKnown.km!) / yearsToLast
        : lastKnown.km! / yearsToLast;

    // ── Segmentos entre revisiones consecutivas ──────────────────────────────
    const segments: MileageSegment[] = [];
    let rollbackDetected = false;

    for (let i = 1; i < withKm.length; i++) {
        const prev = withKm[i - 1];
        const curr = withKm[i];
        const daysDiff = (new Date(curr.date).getTime() - new Date(prev.date).getTime()) / (1000 * 60 * 60 * 24);
        const yearsDiff = Math.max(0.1, daysDiff / 365);
        const kmDelta = curr.km! - prev.km!;
        const kmPerYear = kmDelta / yearsDiff;

        let anomaly: string | null = null;
        if (kmDelta < 0) {
            // Tras LNDS, cualquier delta negativo restante entre lecturas creíbles
            // es un rollback sostenido — la serie nunca recuperó.
            anomaly = 'ODÓMETRO RETROCEDE — posible adulteración';
            rollbackDetected = true;
        } else if (kmDelta === 0 && yearsDiff > 0.05) {
            anomaly = 'PTR repite mismo km — dato no confiable';
        } else if (kmPerYear > NORMAL_KM_PER_YEAR * 2.5) {
            anomaly = 'Uso extremadamente intensivo';
        } else if (kmPerYear < NORMAL_KM_PER_YEAR * 0.1 && yearsDiff > 1.5) {
            anomaly = 'Km sospechosamente bajo para el período';
        }

        segments.push({
            from: prev.date,
            to: curr.date,
            kmStart: prev.km!,
            kmEnd: curr.km!,
            kmDelta,
            years: yearsDiff,
            kmPerYear,
            anomaly,
        });
    }

    // ── Detección de km repetido (PTR copia el valor anterior 3+ veces) ──────
    let repeatedKmDetected = false;
    let repeatedKmValue: number | null = null;
    let repeatedKmCount = 0;
    let estimatedRealKm: number | null = null;
    let estimatedNote: string | null = null;

    if (withKm.length >= 3) {
        let currentStreak = 1;
        let streakKm = withKm[0].km!;
        for (let i = 1; i < withKm.length; i++) {
            if (withKm[i].km === streakKm) {
                currentStreak++;
            } else {
                currentStreak = 1;
                streakKm = withKm[i].km!;
            }
            if (currentStreak >= 3 && !repeatedKmDetected) {
                repeatedKmDetected = true;
                repeatedKmValue = streakKm;
                repeatedKmCount = currentStreak;
            } else if (repeatedKmDetected && currentStreak > repeatedKmCount && withKm[i].km === repeatedKmValue) {
                repeatedKmCount = currentStreak;
            }
        }
        if (repeatedKmDetected) {
            estimatedRealKm = vehicleAge * ESTIMATED_KM_PER_YEAR;
            estimatedNote = `La PTR registra ${repeatedKmValue?.toLocaleString()} km en ${repeatedKmCount} revisiones consecutivas — dato no confiable. ` +
                `Km estimado real: ~${estimatedRealKm.toLocaleString()} km (basado en ${ESTIMATED_KM_PER_YEAR.toLocaleString()} km/año × ${vehicleAge} años)`;
        }
    }

    // ── Estado general del odómetro ──────────────────────────────────────────
    let status: string;
    if (repeatedKmDetected) {
        status = 'DATO NO CONFIABLE — PTR repite km';
    } else if (rollbackDetected) {
        status = 'ADULTERACIÓN DETECTADA';
    } else if (avgKmPerYear > NORMAL_KM_PER_YEAR * 1.5) {
        status = 'ALTO';
    } else if (avgKmPerYear > NORMAL_KM_PER_YEAR * 1.2) {
        status = 'MEDIO-ALTO';
    } else if (avgKmPerYear < NORMAL_KM_PER_YEAR * 0.3 && vehicleAge > 3) {
        status = 'SOSPECHOSAMENTE BAJO';
    } else {
        status = 'NORMAL';
    }

    return {
        lastKnown: { km: lastKnown.km!, date: lastKnown.date },
        firstKnown: { km: firstKnown.km!, date: firstKnown.date },
        avgKmPerYear,
        estimatedRealKm,
        estimatedNote,
        repeatedKmDetected,
        status,
        inHomologationPeriod,
        timeline,
        segments,
        rollbackDetected,
        totalReviews: timeline.length,
        reviewsWithKm: withKm.length,
        dataEntryErrorsFiltered: dataEntryErrors.length,
    };
}
