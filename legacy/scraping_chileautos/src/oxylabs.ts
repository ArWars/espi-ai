/**
 * OxyLabs Universal Scraper API wrapper
 * Handles rendering, geo-targeting, retries with exponential backoff
 * 
 * WAF Protection (DataDome):
 * - Detects blocked/WAF responses by content size and patterns
 * - Adaptive delay: increases wait time on consecutive blocks
 * - Session rotation: requests new IP on WAF detection
 * - Jitter: randomizes delays to avoid pattern detection
 */
import { config } from './config.js';
import { log, sleep } from './utils.js';

interface OxylabsResponse {
    results: Array<{
        content: string;
        status_code: number;
        url: string;
    }>;
}

// ─── WAF Detection ────────────────────────────────────────────────
// DataDome blocked pages are typically:
// - Very small (~2KB-6KB) vs real content (50KB-500KB)
// - Contain "Página no encontrada" or similar error text
// - Contain DataDome challenge scripts
// - Missing expected content markers (gallery_meta, listing-item, etc.)

const WAF_INDICATORS = [
    'captcha',
    'access denied',
    'blocked',
    'página no encontrada',
    'pagina no encontrada',
    'please verify',
    'checking your browser',
    'just a moment',
    'ray id',
    'challenge-platform',
    'cf-browser-verification',
    'security check',
];

const MIN_VALID_LISTING_SIZE = 15_000;  // Real listing pages are 50KB+
const MIN_VALID_DETAIL_SIZE = 10_000;   // Real detail pages are 30KB+
const WAF_BLOCK_SIZE_THRESHOLD = 8_000; // Blocked pages are typically <8KB

/**
 * Check if a response appears to be WAF-blocked
 * 
 * IMPORTANT: We use POSITIVE validation (check if content IS valid) rather
 * than keyword scanning, because DataDome's JS script contains words like
 * "captcha" even on perfectly valid pages.
 */
export function isWafBlocked(html: string, expectedType: 'listing' | 'detail' = 'detail'): { blocked: boolean; reason: string } {
    const htmlLower = html.toLowerCase();
    const size = html.length;

    // ── Positive check: If page has expected content, it's NOT blocked ──
    // Sitio nuevo (Next.js SPA): los listados traen anchors /vehiculos/detalles/
    // y las páginas de detalle traen el blob __NEXT_DATA__.
    if (expectedType === 'listing') {
        const hasListings = htmlLower.includes('/vehiculos/detalles/') ||
            htmlLower.includes('listing-item');
        if (hasListings) {
            return { blocked: false, reason: '' };
        }
    } else {
        const hasDetail = htmlLower.includes('__next_data__') ||
            htmlLower.includes('pageleveltarget') ||
            htmlLower.includes('gallery_meta');
        if (hasDetail) {
            return { blocked: false, reason: '' };
        }
    }

    // ── If we get here, page lacks expected content — check if it's a block ──

    // Check 1: Very small page (DataDome blocks are ~2-6KB, valid pages are 50KB+)
    if (size < 8_000) {
        return { blocked: true, reason: `Page too small: ${(size / 1024).toFixed(1)}KB — likely WAF block` };
    }

    // Check 2: Check for block indicators ONLY in the <body> text
    // (Skip script tags to avoid false positives from DataDome JS)
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    const bodyText = bodyMatch ? bodyMatch[1].replace(/<script[\s\S]*?<\/script>/gi, '').toLowerCase() : htmlLower;

    const BLOCK_INDICATORS = [
        'access denied',
        'página no encontrada',
        'pagina no encontrada',
        'please verify you are a human',
        'checking your browser',
        'just a moment',
    ];

    for (const indicator of BLOCK_INDICATORS) {
        if (bodyText.includes(indicator)) {
            return { blocked: true, reason: `Block indicator in body: "${indicator}"` };
        }
    }

    // Check 3: Page is medium-sized but missing expected content
    const minSize = expectedType === 'listing' ? 15_000 : 10_000;
    if (size < minSize) {
        return { blocked: true, reason: `Page (${(size / 1024).toFixed(1)}KB) missing expected ${expectedType} content markers` };
    }

    // Large page without expected content — might be a different type of page, not necessarily blocked
    return { blocked: false, reason: '' };
}

// ─── Adaptive Throttling ──────────────────────────────────────────
// Tracks consecutive blocks and increases delay accordingly

let consecutiveBlocks = 0;
let totalBlocks = 0;
let totalRequests = 0;

function getAdaptiveDelay(): number {
    if (consecutiveBlocks === 0) return 0;

    // Exponential backoff: 5s, 15s, 45s, 60s, 120s (capped)
    const baseDelay = 5000;
    const delay = Math.min(baseDelay * Math.pow(3, consecutiveBlocks - 1), 120_000);

    // Add jitter ±30%
    const jitter = delay * 0.3 * (Math.random() * 2 - 1);

    return Math.round(delay + jitter);
}

function addRandomJitter(baseMs: number): number {
    // Add ±20% jitter to any delay
    const jitter = baseMs * 0.2 * (Math.random() * 2 - 1);
    return Math.round(baseMs + jitter);
}

export function getWafStats() {
    return {
        totalRequests,
        totalBlocks,
        consecutiveBlocks,
        blockRate: totalRequests > 0 ? (totalBlocks / totalRequests * 100).toFixed(1) + '%' : '0%',
    };
}

export function resetWafStats() {
    consecutiveBlocks = 0;
    totalBlocks = 0;
    totalRequests = 0;
}

// ─── Main Fetch Function ──────────────────────────────────────────

/**
 * Fetch HTML content via OxyLabs Universal Scraper
 * Uses render:html to bypass WAF/DataDome
 * Includes WAF detection, adaptive throttling, and session rotation
 */
export async function fetchWithOxylabs(
    url: string,
    options: { expectedType?: 'listing' | 'detail'; forceNewSession?: boolean } = {}
): Promise<string | null> {
    const { username, password, apiUrl, geoLocation } = config.oxylabs;
    const maxRetries = config.scraping.maxRetries;
    const { expectedType = 'detail' } = options;

    totalRequests++;

    // Adaptive delay: if we've been getting blocked, wait before requesting
    const adaptiveDelay = getAdaptiveDelay();
    if (adaptiveDelay > 0) {
        log('warn', `⏳ Adaptive delay: ${(adaptiveDelay / 1000).toFixed(1)}s (${consecutiveBlocks} consecutive blocks)`);
        await sleep(adaptiveDelay);
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const payload: Record<string, unknown> = {
                source: 'universal',
                url,
                geo_location: geoLocation,
                render: 'html',
            };

            // Session rotation: use unique session ID on retries after WAF blocks
            if (attempt > 1 || options.forceNewSession) {
                payload.session = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            }

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
                },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(config.scraping.requestTimeoutMs),
            });

            if (response.status === 200) {
                const data = (await response.json()) as OxylabsResponse;
                const content = data.results?.[0]?.content;

                if (!content) {
                    consecutiveBlocks++;
                    totalBlocks++;
                    log('warn', `Empty content from OxyLabs (attempt ${attempt}/${maxRetries}): ${url.slice(0, 80)}`);
                    if (attempt < maxRetries) {
                        const backoffMs = addRandomJitter(8_000 * attempt);
                        log('warn', `   ⏳ Retrying in ${(backoffMs / 1000).toFixed(1)}s...`);
                        await sleep(backoffMs);
                        continue;
                    }
                    return null;
                }

                // ── WAF Check ──
                const wafCheck = isWafBlocked(content, expectedType);
                if (wafCheck.blocked) {
                    consecutiveBlocks++;
                    totalBlocks++;
                    log('warn', `🛡️ WAF BLOCKED (attempt ${attempt}/${maxRetries}): ${wafCheck.reason}`);
                    log('warn', `   URL: ${url.slice(0, 80)}...`);
                    log('warn', `   Block stats: ${consecutiveBlocks} consecutive, ${totalBlocks}/${totalRequests} total`);

                    if (attempt < maxRetries) {
                        // Longer wait on WAF block + jitter
                        const wafDelay = addRandomJitter(10_000 * attempt);
                        log('warn', `   ⏳ WAF retry delay: ${(wafDelay / 1000).toFixed(1)}s`);
                        await sleep(wafDelay);
                        continue;
                    }

                    return null;
                }

                // ── Success! Reset block counter ──
                if (consecutiveBlocks > 0) {
                    log('info', `✅ WAF cleared after ${consecutiveBlocks} consecutive blocks`);
                }
                consecutiveBlocks = 0;

                return content;
            }

            if (response.status === 204) {
                // OxyLabs returns 204 when target page couldn't be fetched — retry with backoff
                const backoffMs = addRandomJitter(5000 * attempt);
                log('warn', `OxyLabs 204 (no content), retrying in ${(backoffMs / 1000).toFixed(1)}s... (attempt ${attempt}/${maxRetries})`);
                if (attempt < maxRetries) {
                    await sleep(backoffMs);
                    continue;
                }
                log('error', `OxyLabs 204 after ${maxRetries} attempts for ${url.slice(0, 80)}`);
                return null;
            }

            if (response.status === 429) {
                // Rate limited — wait and retry
                const backoffMs = addRandomJitter(Math.min(2000 * Math.pow(2, attempt), 30000));
                log('warn', `Rate limited (429), waiting ${(backoffMs / 1000).toFixed(1)}s... (attempt ${attempt}/${maxRetries})`);
                await sleep(backoffMs);
                continue;
            }

            if (response.status >= 500) {
                // Server error — retry
                const backoffMs = addRandomJitter(3000 * attempt);
                log('warn', `Server error ${response.status}, retrying in ${(backoffMs / 1000).toFixed(1)}s... (attempt ${attempt}/${maxRetries})`);
                await sleep(backoffMs);
                continue;
            }

            // Client error (4xx except 429) — don't retry
            const errorBody = await response.text().catch(() => '');
            log('error', `OxyLabs error ${response.status}: ${errorBody.slice(0, 200)}`);
            return null;

        } catch (error) {
            const isTimeout = error instanceof Error && error.name === 'TimeoutError';
            if (isTimeout && attempt < maxRetries) {
                log('warn', `Timeout, retrying... (attempt ${attempt}/${maxRetries})`);
                await sleep(addRandomJitter(2000 * attempt));
                continue;
            }
            log('error', `Fetch exception: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    }

    log('error', `All ${maxRetries} attempts failed for ${url}`);
    return null;
}
