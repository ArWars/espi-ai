// ─────────────────────────────────────────────────────────────────────────────
// domain/fines.ts — Cálculo de multas y deudas (determinista)
// Puerto 1:1 de calculateRealFines() del lambda legacy.
// ─────────────────────────────────────────────────────────────────────────────
import type { FinesData, RealFines } from '../types.ts';

/** $69.265 + $4.000 (2024) — estimación por multa municipal sin monto real. */
export const MULTA_MUNICIPAL_ESTIMADA = 73265;

export function calculateRealFines(fines: FinesData | null | undefined): RealFines {
    // Autopistas — estructura: { "CONCESIONARIA": [{ total_ballot, paid, ... }] }
    const highways = { total: 0, count: 0, unpaid: 0, paid: 0 };
    if (fines?.highways) {
        for (const tickets of Object.values(fines.highways)) {
            if (Array.isArray(tickets)) {
                for (const ticket of tickets) {
                    const amount = parseInt(String(ticket.total_ballot)) || parseInt(String(ticket.amount)) || 0;
                    highways.count++;
                    if (ticket.paid === 'NO PAGADA' || ticket.paid === 'UNPAID' || !ticket.paid) {
                        highways.total += amount;
                        highways.unpaid++;
                    } else {
                        highways.paid++;
                    }
                }
            }
        }
    }

    // Municipales — estructura anidada irregular del scraper
    let municipals: RealFines['municipals'] = { total: 0, count: 0, source: 'real' };
    if (fines?.municipalities) {
        const addFine = (fine: { amount?: string | number | null }) => {
            municipals.total += parseInt(String(fine.amount)) || 0;
            municipals.count++;
        };
        for (const municipality of Object.values(fines.municipalities)) {
            if (typeof municipality === 'object' && municipality !== null) {
                for (const commune of Object.values(municipality as Record<string, unknown>)) {
                    if (typeof commune === 'object' && commune !== null && !Array.isArray(commune)) {
                        for (const fineType of Object.values(commune as Record<string, unknown>)) {
                            if (Array.isArray(fineType)) {
                                for (const fine of fineType as { amount?: string | number | null }[]) {
                                    addFine(fine);
                                }
                            }
                        }
                    } else if (Array.isArray(commune)) {
                        for (const fine of commune as { amount?: string | number | null }[]) {
                            addFine(fine);
                        }
                    }
                }
            }
        }

        // Estimación si no hay montos reales
        if (municipals.total === 0 && fines?.externals) {
            const newExternals = fines.externals.filter((f) => f.type === 'new');
            const uniqueDescriptions = [...new Set(newExternals.map((f) => f.description))];
            municipals = {
                total: uniqueDescriptions.length * MULTA_MUNICIPAL_ESTIMADA,
                count: uniqueDescriptions.length,
                source: 'estimated',
            };
        }
    }

    // Externas (informativas, $0)
    const externals = { count: fines?.externals?.length || 0, total: 0 };

    return {
        highways,
        municipals,
        externals,
        totalDebt: highways.total + municipals.total,
    };
}
