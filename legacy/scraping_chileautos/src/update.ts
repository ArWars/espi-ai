/**
 * Incremental Update Module for ChileAutos Scraper
 * 
 * Orchestrates: Phase 1 (URL collection) → Diff vs DB → Phase 2 (new URLs only) → Mark delisted
 */
import { BRANDS, Brand } from './brands.js';
import { extractUrlsByBrand } from './phase1-urls.js';
import { scrapeVehicleDetails } from './phase2-details.js';
import { FirestoreWriter } from './firestore.js';
import { log } from './utils.js';
import fs from 'fs';

export interface UpdateConfig {
    /** Brand slugs to process (empty = all brands) */
    brands?: string[];
    /** Skip Phase 1 and use existing URL files */
    skipPhase1?: boolean;
    /** Skip marking delisted vehicles */
    skipDelisted?: boolean;
    /** VPS ID for logging */
    vpsId?: number;
}

export interface UpdateReport {
    startTime: string;
    endTime: string;
    durationMinutes: number;
    phase1: {
        brandsProcessed: number;
        totalUrlsCollected: number;
    };
    diff: {
        existingInDb: number;
        newUrls: number;
        delistedUrls: number;
    };
    phase2: {
        scraped: number;
        errors: number;
    };
    delisted: {
        marked: number;
        failed: number;
    };
}

/**
 * Run an incremental update
 * 
 * 1. Phase 1: Collect current URLs from ChileAutos for assigned brands
 * 2. Diff: Compare collected URLs with DynamoDB
 * 3. Phase 2: Scrape only NEW URLs (not in DB)
 * 4. Mark Delisted: Flag URLs that are in DB but no longer on ChileAutos
 */
export async function runUpdate(config: UpdateConfig = {}): Promise<UpdateReport> {
    const startTime = new Date();
    const vpsLabel = config.vpsId ? `VPS ${config.vpsId}` : 'LOCAL';

    log('info', `═══════════════════════════════════════════════════`);
    log('info', `🔄 INCREMENTAL UPDATE — ${vpsLabel}`);
    log('info', `═══════════════════════════════════════════════════`);

    // ── Determine brands to process ──
    let brandsToProcess: Brand[];
    if (config.brands && config.brands.length > 0) {
        brandsToProcess = config.brands
            .map(slug => BRANDS.find(b => b.slug === slug.toLowerCase()))
            .filter((b): b is Brand => b !== undefined);

        if (brandsToProcess.length === 0) {
            log('error', 'No valid brands found from config');
            throw new Error('No valid brands');
        }
    } else {
        brandsToProcess = [...BRANDS];
    }

    log('info', `📋 Brands to process: ${brandsToProcess.length}`);

    // ═════════════════════════════════════════════════
    // STEP 1: Phase 1 — Collect current URLs
    // ═════════════════════════════════════════════════
    let allCollectedUrls = new Set<string>();

    if (!config.skipPhase1) {
        log('info', '');
        log('info', `═══ STEP 1: Phase 1 — Collecting URLs ═══`);

        for (const brand of brandsToProcess) {
            try {
                const result = await extractUrlsByBrand(brand);
                for (const url of result.urls) {
                    allCollectedUrls.add(url);
                }
                log('info', `  ${brand.name}: ${result.urls.length} URLs`);
            } catch (err) {
                log('error', `  ${brand.name}: Phase 1 failed — ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    } else {
        // Load from existing output files
        log('info', '⏭  Skipping Phase 1 — loading from existing files');
        for (const brand of brandsToProcess) {
            const pattern = `output/urls_${brand.slug}_`;
            const files = fs.readdirSync('output').filter(f => f.startsWith(`urls_${brand.slug}_`));
            if (files.length > 0) {
                const latest = files.sort().pop()!;
                const data = JSON.parse(fs.readFileSync(`output/${latest}`, 'utf-8'));
                const urls: string[] = Array.isArray(data) ? data : (data.urls || []);
                for (const url of urls) allCollectedUrls.add(url);
            }
        }
    }

    log('info', `📊 Total URLs collected: ${allCollectedUrls.size.toLocaleString()}`);

    // ═════════════════════════════════════════════════
    // STEP 2: Diff — Comparar con Firestore
    // ═════════════════════════════════════════════════
    log('info', '');
    log('info', `═══ STEP 2: Diff — Comparando con Firestore ═══`);

    const firestore = new FirestoreWriter();
    const existingUrlMap = await firestore.loadExistingUrlMap();
    const existingUrls = new Set(existingUrlMap.keys());

    // Find new URLs (in ChileAutos but not in DB)
    const newUrls: string[] = [];
    for (const url of allCollectedUrls) {
        if (!existingUrls.has(url)) {
            newUrls.push(url);
        }
    }

    // Find delisted URLs (in DB but not in ChileAutos anymore)
    // Only for the brands we're processing
    const brandSlugs = new Set(brandsToProcess.map(b => b.slug.toLowerCase()));
    const delistedIds: string[] = [];

    if (!config.skipDelisted) {
        for (const [url, vehicleId] of existingUrlMap) {
            // Only check URLs that belong to brands we processed
            const urlBrand = extractBrandFromUrl(url);
            if (urlBrand && brandSlugs.has(urlBrand) && !allCollectedUrls.has(url)) {
                delistedIds.push(vehicleId);
            }
        }
    }

    log('info', `📊 Existing in DB: ${existingUrls.size.toLocaleString()}`);
    log('info', `🆕 New URLs: ${newUrls.length.toLocaleString()}`);
    log('info', `🚫 Delisted: ${delistedIds.length.toLocaleString()}`);

    // ═════════════════════════════════════════════════  
    // STEP 3: Phase 2 — Scrape new URLs
    // ═════════════════════════════════════════════════
    let phase2Results = { scraped: 0, errors: 0 };

    if (newUrls.length > 0) {
        log('info', '');
        log('info', `═══ STEP 3: Phase 2 — Scraping ${newUrls.length} nuevas URLs ═══`);

        const dateStr = new Date().toISOString().slice(0, 10);
        const batchName = `update_${vpsLabel.toLowerCase().replace(' ', '')}_${dateStr}`;

        const result = await scrapeVehicleDetails(newUrls, {
            saveToFirestore: true,
            batchName,
        });

        phase2Results = {
            scraped: result.results.length,
            errors: result.errors.length,
        };
    } else {
        log('info', '✅ No new URLs to scrape');
    }

    // ═════════════════════════════════════════════════
    // STEP 4: Mark delisted vehicles
    // ═════════════════════════════════════════════════
    let delistedResults = { marked: 0, failed: 0 };

    if (delistedIds.length > 0 && !config.skipDelisted) {
        log('info', '');
        log('info', `═══ STEP 4: Marcando ${delistedIds.length} vehículos deslistados ═══`);

        const result = await firestore.markDelisted(delistedIds);
        delistedResults = { marked: result.updated, failed: result.failed };

        log('info', `✅ Marked: ${result.updated}, Failed: ${result.failed}`);
    }

    // ═════════════════════════════════════════════════
    // REPORT
    // ═════════════════════════════════════════════════
    const endTime = new Date();
    const durationMinutes = Math.round((endTime.getTime() - startTime.getTime()) / 60000);

    const report: UpdateReport = {
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        durationMinutes,
        phase1: {
            brandsProcessed: brandsToProcess.length,
            totalUrlsCollected: allCollectedUrls.size,
        },
        diff: {
            existingInDb: existingUrls.size,
            newUrls: newUrls.length,
            delistedUrls: delistedIds.length,
        },
        phase2: phase2Results,
        delisted: delistedResults,
    };

    log('info', '');
    log('info', `═══════════════════════════════════════════════════`);
    log('info', `✅ UPDATE COMPLETE — ${vpsLabel}`);
    log('info', `⏱  Duration: ${durationMinutes} min`);
    log('info', `📊 Phase 1: ${allCollectedUrls.size} URLs from ${brandsToProcess.length} brands`);
    log('info', `🆕 New: ${phase2Results.scraped} scraped (${phase2Results.errors} errors)`);
    log('info', `🚫 Delisted: ${delistedResults.marked} marked`);
    log('info', `═══════════════════════════════════════════════════`);

    // Save report
    const reportDir = 'output/reports';
    if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
    const reportFile = `${reportDir}/update_${vpsLabel.toLowerCase().replace(' ', '')}_${endTime.toISOString().slice(0, 10)}.json`;
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
    log('info', `📄 Report saved: ${reportFile}`);

    return report;
}

/**
 * Extract brand slug from a ChileAutos URL
 * E.g. https://www.chileautos.cl/vehiculos/detalles/2024-chevrolet-spark/... → chevrolet
 */
function extractBrandFromUrl(url: string): string | null {
    // Pattern: /detalles/YEAR-BRAND-MODEL/ or /detalles/BRAND-MODEL-YEAR/
    const match = url.match(/\/detalles\/(?:\d{4}-)?([a-z][a-z0-9-]+?)[-/]/i);
    if (match) {
        return match[1].toLowerCase();
    }
    return null;
}
