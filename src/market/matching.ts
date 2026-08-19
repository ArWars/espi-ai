// ─────────────────────────────────────────────────────────────────────────────
// market/matching.ts — Matching fuzzy de modelo/versión para comparables
// Puerto 1:1 de los helpers internos de querySimilarVehicles() del lambda.
// ─────────────────────────────────────────────────────────────────────────────
import type { ComparableListing } from '../types.ts';

export const YEAR_RANGE = 2;
export const MAX_QUERY_TIME_MS = 25000;
export const MAX_PAGES_PER_YEAR = 10;

const normalize = (str: string | null | undefined): string =>
    str ? str.toLowerCase().replace(/[\s-]/g, '') : '';

export const levenshtein = (a: string, b: string): number => {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
        }
    }
    return dp[m][n];
};

const firstWord = (s: string): string => s.split(/(?=[A-Z0-9])/)[0] || s;

export const dbBrand = (brand: string): string => brand.toLowerCase().replace(/\s+/g, '-');

// ── Versiones/trim conocidos (para separar modelo base de versión) ──────────
export const KNOWN_VERSIONS = [
    'rs', 'gt', 'ltz', 'lt', 'ls', 'lx', 'ex', 'premier', 'high country',
    'limited', 'sport', 'active', 'allure', 'feline', 'style', 'comfort',
    'luxury', 'elite', 'exclusive', 'dynamic', 'advance', 'turbo',
    'glx', 'gls', 'gl', 'dx', 'xe', 'se', 'r-design', 'amg', 'm-sport',
    'n-line', 'line', 'pack', 'plus', 'pro', 'premium', 'platinum',
];

export function splitModelVersion(model: string | null | undefined): { modelBase: string; targetVersion: string } {
    let modelBase = model || '';
    let targetVersion = '';

    modelBase = modelBase
        .replace(/\s+(AUT|AUTO|AUTOMATICO|AUTOMÁTICO|AT|MT|MANUAL|AWD|4WD|FWD|RWD|CVT|DSG)$/i, '')
        .trim();

    for (const ver of KNOWN_VERSIONS) {
        const regex = new RegExp(`\\b${ver}\\b`, 'i');
        if (regex.test(modelBase)) {
            targetVersion = ver;
            modelBase = modelBase.replace(regex, '').trim();
            break;
        }
    }
    return { modelBase, targetVersion };
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** ¿Este comparable corresponde al modelo buscado? (guards de cortos + fuzzy) */
export function matchesTargetModel(itemModelRaw: string | null | undefined, targetModel: string): boolean {
    const itemModel = normalize(itemModelRaw);
    if (targetModel.includes('cla') && itemModel.includes('clasea')) return false;
    if (targetModel.includes('clasea') && itemModel.includes('cla') && !itemModel.includes('clasea')) return false;

    // Guard: modelo del item muy corto (<=3 chars, ej "2","3","6") — solo si
    // targetModel empieza con el mismo prefijo (evita "mazda 2" en "mx-5 2.0")
    if (itemModel.length <= 3 && targetModel.length > itemModel.length) {
        return new RegExp('^' + escapeRegExp(itemModel), 'i').test(targetModel);
    }

    // Guard: targetModel muy corto — requerir match exacto o prefijo
    if (targetModel.length <= 3 && itemModel.length > targetModel.length) {
        return new RegExp('^' + escapeRegExp(targetModel), 'i').test(itemModel);
    }

    const fw1 = firstWord(itemModel);
    const fw2 = firstWord(targetModel);
    const fuzzy = fw1.length > 3 && fw2.length > 3 && levenshtein(fw1, fw2) <= 2;
    return itemModel.includes(targetModel) || targetModel.includes(itemModel) || fuzzy;
}

/** Deduplicar por URL (primera aparición gana). */
export function dedupeByUrl(items: ComparableListing[]): ComparableListing[] {
    return items.filter((v, i, self) => i === self.findIndex((t) => t.url === v.url));
}

/** Scoring de relevancia (versión + cercanía de año). Mutuamente exclusivo con dedupeByUrl? No: aplica tras dedupe. */
export function scoreByVersionAndYear(
    comparables: ComparableListing[],
    targetVersion: string,
    yearInt: number
): ComparableListing[] {
    if (!targetVersion) return comparables;
    const targetVerNorm = normalize(targetVersion);

    const scored = comparables.map((v) => {
        let score = 0;
        const itemDistintivo = normalize(v.distintivo || '');
        const itemVersion = normalize(v.version || '');
        const itemTitulo = normalize(v.titulo_completo || '');
        if (itemDistintivo.includes(targetVerNorm) || itemVersion.includes(targetVerNorm) || itemTitulo.includes(targetVerNorm)) {
            score += 10;
        }
        const yearDiff = Math.abs((v.ano || yearInt) - yearInt);
        score += (YEAR_RANGE - yearDiff) * 2;
        return { ...v, matchScore: score };
    });

    const withVersion = scored.filter((v) => (v.matchScore ?? 0) >= 10);
    const withoutVersion = scored.filter((v) => (v.matchScore ?? 0) < 10);
    if (withVersion.length >= 3) {
        return withVersion; // filtrado duro por versión exacta
    }
    return scored.sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0)); // fallback ordenado
}

/** Filtro IQR de outliers de precio. */
export function iqrFilter(comparables: ComparableListing[]): ComparableListing[] {
    if (comparables.length < 5) return comparables;
    const prices = comparables.map((v) => v.precio_clp).sort((a, b) => a - b);
    const q1 = prices[Math.floor(prices.length * 0.25)];
    const q3 = prices[Math.floor(prices.length * 0.75)];
    const iqr = q3 - q1;
    const lower = q1 - 1.5 * iqr;
    const upper = q3 + 1.5 * iqr;
    return comparables.filter((v) => v.precio_clp >= lower && v.precio_clp <= upper);
}
