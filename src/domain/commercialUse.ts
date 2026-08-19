// ─────────────────────────────────────────────────────────────────────────────
// domain/commercialUse.ts — Detección heurística de uso comercial (taxi/app)
// Puerto 1:1 de analyzeCommercialUse() del lambda legacy.
// ─────────────────────────────────────────────────────────────────────────────
import type { CommercialUseAnalysis, FinesData } from '../types.ts';

export function analyzeCommercialUse(fines: FinesData | null | undefined): CommercialUseAnalysis {
    const notFlagged: CommercialUseAnalysis = {
        flagged: false,
        confidence: 'baja',
        totalFines: 0,
        uniqueMunicipalities: 0,
        finesPerYear: 0,
        municipalitiesList: [],
        finesByYear: {},
        pattern: 'Sin indicadores de uso comercial',
        priceImpact: 'Ninguno',
    };
    if (!fines) return { ...notFlagged, totalFines: 0, uniqueMunicipalities: 0 };

    const municipalities = new Set<string>();
    const finesByYear: Record<string, number> = {};
    let externalCount = 0;

    // Multas externas (JPL) — comuna desde nombre del juzgado, año desde descripción
    if (fines.externals?.length) {
        for (const fine of fines.externals) {
            externalCount++;
            const courtName = fine.court?.name || '';
            if (courtName) {
                const commune = courtName.replace(/^\d+\s*JPL\s*/i, '').replace(/\s*JPL$/i, '').trim();
                if (commune) municipalities.add(commune.toUpperCase());
            }
            const yearMatch = fine.description?.match(/\b(20[0-2]\d)\b/);
            if (yearMatch) {
                finesByYear[yearMatch[1]] = (finesByYear[yearMatch[1]] || 0) + 1;
            }
        }
    }

    // Multas de autopista — contar boletas únicas; el año de cada boleta
    // (campo `date`, YYYY-MM-DD) también alimenta finesByYear para no inflar
    // finesPerYear cuando el vehículo solo tiene multas de autopista.
    let highwayTickets = 0;
    if (fines.highways) {
        for (const concession of Object.values(fines.highways)) {
            if (Array.isArray(concession)) {
                highwayTickets += concession.length;
                for (const toll of concession) {
                    const d = typeof toll?.date === 'string' ? toll.date : '';
                    const yearMatch = d.match(/\b(20[0-2]\d)\b/);
                    if (yearMatch) {
                        finesByYear[yearMatch[1]] = (finesByYear[yearMatch[1]] || 0) + 1;
                    }
                }
            }
        }
    }

    const totalFines = externalCount + highwayTickets;
    const uniqueMunicipalities = municipalities.size;
    const validYears = Object.keys(finesByYear).map(Number).filter((y) => y >= 2000 && y <= 2030).sort((a, b) => a - b);
    const activeYears = validYears.length >= 2
        ? validYears[validYears.length - 1] - validYears[0] + 1
        : Math.max(1, validYears.length);
    const finesPerYear = totalFines / activeYears;

    // Criterios heurísticos — presentado como "atención", no hecho confirmado
    const flagged =
        (uniqueMunicipalities >= 5 && finesPerYear >= 8) ||
        (totalFines >= 50 && uniqueMunicipalities >= 3) ||
        finesPerYear >= 15;

    let confidence: CommercialUseAnalysis['confidence'] = 'baja';
    let pattern = 'Sin indicadores de uso comercial';
    let priceImpact = 'Ninguno';

    if (flagged) {
        if (finesPerYear >= 20 && uniqueMunicipalities >= 10) {
            confidence = 'alta';
            pattern = 'Alta dispersión geográfica + frecuencia elevada — compatible con taxi o app de transporte';
            priceImpact = '-12% a -15% si se confirma uso comercial';
        } else if (finesPerYear >= 10 || uniqueMunicipalities >= 6) {
            confidence = 'media';
            pattern = 'Dispersión y frecuencia moderada — podría ser uso comercial (delivery/flota) o conductor particular con muchas infracciones';
            priceImpact = '-8% a -12% si se confirma uso comercial';
        } else {
            confidence = 'baja';
            pattern = 'Volumen alto de multas — podría indicar uso semi-comercial, pero también un particular descuidado';
            priceImpact = '-5% a -8% si se confirma uso comercial';
        }
    }

    return {
        flagged,
        confidence,
        totalFines,
        uniqueMunicipalities,
        finesPerYear,
        municipalitiesList: [...municipalities].sort(),
        finesByYear,
        pattern,
        priceImpact,
    };
}
