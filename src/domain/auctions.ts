// ─────────────────────────────────────────────────────────────────────────────
// domain/auctions.ts — Análisis de remates/siniestros
// Puerto 1:1 de analyzeAuctions() del lambda legacy.
// ─────────────────────────────────────────────────────────────────────────────
import type { AuctionAnalysis, AuctionRecord } from '../types.ts';

export function analyzeAuctions(auctions: AuctionRecord[] | null | undefined): AuctionAnalysis {
    if (!auctions?.length) {
        return { hasAuction: false };
    }

    const relevant = auctions.find(
        (a) =>
            a.operation &&
            (a.operation.toUpperCase().includes('REMATE') || a.operation.toUpperCase().includes('PERDIDA'))
    );

    if (!relevant) {
        return { hasAuction: false };
    }

    return {
        hasAuction: true,
        type: relevant.type || 'N/D',
        company: relevant.company || 'Aseguradora desconocida',
        operation: relevant.operation || 'REMATE',
        date: relevant.date ? new Date(relevant.date).toLocaleDateString('es-CL') : 'N/D',
    };
}
