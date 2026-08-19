/**
 * Phase 1: URL Collector
 * Paginates ChileAutos listings by brand and extracts vehicle detail URLs.
 *
 * ⚠️ ChileAutos migró a una SPA Next.js (2026). Cambios vs versión anterior:
 *   - La paginación por `&offset=N` dejó de funcionar (el sitio la ignora).
 *     Ahora se pagina con el token `_.Page.N.` dentro del filtro q=.
 *   - El contenedor `div.listing-item.card` ya no existe. Los links de detalle
 *     se extraen directamente de los `<a href="/vehiculos/detalles/...">`.
 *   - El token `_.Page.N.` pagina en profundidad SIN el tope de ~420 resultados,
 *     por lo que ya no se necesita la cascada Marca→Modelo→Año.
 */
import * as cheerio from 'cheerio';
import { config } from './config.js';
import { fetchWithOxylabs, getWafStats } from './oxylabs.js';
import { log, sleep, saveCheckpoint, loadCheckpoint, deleteCheckpoint, saveOutput, progressBar } from './utils.js';
import type { Brand } from './brands.js';

// ─── Constants ───────────────────────────────────────────────────

/** Páginas consecutivas sin URLs nuevas antes de declarar el fin de la marca */
const MAX_EMPTY_PAGES = 2;

/** Reintentos de fetch por página antes de abortar la marca */
const MAX_PAGE_RETRIES = 3;

export interface Phase1Result {
    brand: string;
    slug: string;
    urls: string[];
    pagesScraped: number;
    startedAt: string;
    completedAt: string;
}

// ─── URL Building & Extraction ────────────────────────────────────

/**
 * Build a paginated brand listing URL using the q= DSL Page token.
 * e.g. (And.Servicio.chileautos._.Marca.Maserati._.Page.3.)
 */
function buildBrandPageUrl(brandName: string, page: number): string {
    const q = `(And.Servicio.chileautos._.Marca.${brandName}._.Page.${page}.)`;
    return `${config.chileautos.baseUrl}/vehiculos/?q=${encodeURIComponent(q)}`;
}

/**
 * Extract vehicle detail URLs from a listing page.
 * Selects all anchors pointing at /vehiculos/detalles/ (robust to container
 * class changes), strips query/fragment, and normalizes to the same format
 * stored in Firestore (full https URL, trailing slash preserved).
 */
function extractDetailUrls($: cheerio.CheerioAPI, collected: Set<string>): number {
    let added = 0;
    $('a[href*="/vehiculos/detalles/"]').each((_, el) => {
        const href = $(el).attr('href');
        if (!href) return;
        const clean = href.split('?')[0].split('#')[0];
        const fullUrl = clean.startsWith('http') ? clean : `${config.chileautos.baseUrl}${clean}`;
        if (!collected.has(fullUrl)) {
            collected.add(fullUrl);
            added++;
        }
    });
    return added;
}

/**
 * Fetch a listing page with retries.
 */
async function fetchListingPage(url: string, label: string): Promise<string | null> {
    for (let retry = 1; retry <= MAX_PAGE_RETRIES; retry++) {
        const html = await fetchWithOxylabs(url, { expectedType: 'listing' });
        if (html) return html;
        if (retry < MAX_PAGE_RETRIES) {
            const delay = 15_000 + Math.random() * 15_000;
            log('warn', `${label} — sin HTML (retry ${retry}/${MAX_PAGE_RETRIES}), esperando ${(delay / 1000).toFixed(0)}s...`);
            await sleep(delay);
        }
    }
    return null;
}

// ─── Main Brand Extraction ───────────────────────────────────────

/**
 * Extract all vehicle URLs for a given brand by paginating its q= listing
 * with the Page token until pages stop yielding new URLs.
 */
export async function extractUrlsByBrand(brand: Brand): Promise<Phase1Result> {
    const checkpointId = `phase1_${brand.slug}`;
    const existing = loadCheckpoint(checkpointId);

    const collectedUrls = new Set<string>(existing?.processedUrls || []);
    const startedAt = existing?.updatedAt || new Date().toISOString();
    let page = (existing?.lastPage || 0) + 1;
    let pagesScraped = page - 1;
    let emptyStreak = 0;

    if (existing && collectedUrls.size > 0) {
        log('info', `Resuming ${brand.name}: ${collectedUrls.size} URLs cacheadas, desde página ${page}`);
    }

    for (; page <= config.scraping.maxPagesPerBrand; page++) {
        const url = buildBrandPageUrl(brand.name, page);
        const label = `${brand.name} — página ${page}`;
        log('info', `${label}...`);

        const html = await fetchListingPage(url, label);
        if (!html) {
            log('error', `${label} — sin HTML tras ${MAX_PAGE_RETRIES} reintentos, deteniendo marca`);
            break;
        }

        const $ = cheerio.load(html);
        const anchors = $('a[href*="/vehiculos/detalles/"]').length;

        if (anchors === 0) {
            log('info', `${label} — 0 listings (fin de resultados)`);
            break;
        }

        const added = extractDetailUrls($, collectedUrls);
        pagesScraped = page;
        log('info', `${label} — ${anchors} anchors, +${added} nuevos (total: ${collectedUrls.size})`);

        if (added === 0) {
            emptyStreak++;
            if (emptyStreak >= MAX_EMPTY_PAGES) {
                log('info', `${brand.name} — ${MAX_EMPTY_PAGES} páginas seguidas sin nuevos, fin`);
                break;
            }
        } else {
            emptyStreak = 0;
        }

        // Checkpoint after each page
        saveCheckpoint(checkpointId, {
            phase: 'phase1',
            brand: brand.slug,
            lastPage: pagesScraped,
            processedUrls: Array.from(collectedUrls),
            totalUrls: collectedUrls.size,
            updatedAt: new Date().toISOString(),
        });

        // Delay between pages with jitter ±20%
        const pageDelay = config.scraping.delayBetweenPagesMs;
        const jitteredDelay = Math.round(pageDelay + pageDelay * 0.2 * (Math.random() * 2 - 1));
        await sleep(jitteredDelay);
    }

    const result: Phase1Result = {
        brand: brand.name,
        slug: brand.slug,
        urls: Array.from(collectedUrls),
        pagesScraped,
        startedAt,
        completedAt: new Date().toISOString(),
    };

    const filename = `urls_${brand.slug}_${new Date().toISOString().slice(0, 10)}.json`;
    const filePath = saveOutput(filename, result);
    log('info', `${brand.name} — ${collectedUrls.size} URLs guardadas → ${filePath}`);

    deleteCheckpoint(checkpointId);
    return result;
}

// ─── Multi-Brand Orchestrator ────────────────────────────────────

/**
 * Extract URLs for multiple brands with delays between them
 */
export async function extractUrlsForBrands(brands: Brand[]): Promise<Phase1Result[]> {
    const results: Phase1Result[] = [];

    log('info', `═══════════════════════════════════════════════════`);
    log('info', `PHASE 1 — Extracting URLs for ${brands.length} brands`);
    log('info', `═══════════════════════════════════════════════════`);

    for (let i = 0; i < brands.length; i++) {
        const brand = brands[i];
        log('info', progressBar(i + 1, brands.length, brand.name));

        const result = await extractUrlsByBrand(brand);
        results.push(result);

        log('info', `${brand.name} ✅ — ${result.urls.length} URLs en ${result.pagesScraped} páginas`);

        // Delay between brands (except last one) with jitter
        if (i < brands.length - 1) {
            const baseDelay = config.scraping.delayBetweenBrandsMs;
            const jitteredBrandDelay = Math.round(baseDelay + baseDelay * 0.2 * (Math.random() * 2 - 1));
            log('info', `⏳ Esperando ${(jitteredBrandDelay / 1000).toFixed(0)}s antes de siguiente marca...`);

            const wafStats = getWafStats();
            if (wafStats.totalBlocks > 0) {
                log('warn', `🛡️ WAF stats: ${wafStats.totalBlocks}/${wafStats.totalRequests} blocked (${wafStats.blockRate})`);
            }

            await sleep(jitteredBrandDelay);
        }
    }

    const totalUrls = results.reduce((sum, r) => sum + r.urls.length, 0);
    log('info', `═══════════════════════════════════════════════════`);
    log('info', `PHASE 1 COMPLETADA`);
    log('info', `Total: ${totalUrls} URLs de ${brands.length} marcas`);
    log('info', `═══════════════════════════════════════════════════`);

    return results;
}
