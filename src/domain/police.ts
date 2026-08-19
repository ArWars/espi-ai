// ─────────────────────────────────────────────────────────────────────────────
// domain/police.ts — Interpretación de encargo policial
// Puerto 1:1 de interpretPoliceOrders() del lambda legacy.
// ─────────────────────────────────────────────────────────────────────────────
import type { PoliceOrder, PoliceStatus } from '../types.ts';

export function interpretPoliceOrders(policeOrders: PoliceOrder[] | null | undefined): PoliceStatus {
    if (!policeOrders?.length) {
        return { description: 'Estado no verificado', penalty: '0' };
    }

    const info = (policeOrders[0]?.info || policeOrders[0]?.description || '').toLowerCase();

    if (info.includes('no registra encargo') || info.includes('no mantiene encargo')) {
        return { description: 'Sin encargo policial vigente', penalty: '0' };
    }
    if (info.includes('mantiene encargo') || info.includes('registra encargo')) {
        // FIX-2 (legacy): encargo es CAP (score=min(score,5)), no penalización gradual
        return { description: 'CON ENCARGO POLICIAL VIGENTE', penalty: 'CAP' };
    }
    return { description: 'Estado policial no claro', penalty: '0' };
}
