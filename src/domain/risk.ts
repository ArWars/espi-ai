// ─────────────────────────────────────────────────────────────────────────────
// domain/risk.ts — Riesgo/veredicto determinista desde el score
// Puerto 1:1 de riskFromScore() del lambda legacy (FIX-3).
// ─────────────────────────────────────────────────────────────────────────────
import type { RiskVerdict } from '../types.ts';

/**
 * Gate: intransferible o score<=5 => critical / NO COMPRAR.
 * Bandas: <40 high/NO COMPRAR · <70 medium/NEGOCIAR · >=70 low/COMPRAR.
 */
export function riskFromScore(score: number, transferible = true): RiskVerdict {
    if (!transferible || score <= 5) return { risk_level: 'critical', verdict: 'NO COMPRAR' };
    if (score < 40) return { risk_level: 'high', verdict: 'NO COMPRAR' };
    if (score < 70) return { risk_level: 'medium', verdict: 'NEGOCIAR' };
    return { risk_level: 'low', verdict: 'COMPRAR' };
}
