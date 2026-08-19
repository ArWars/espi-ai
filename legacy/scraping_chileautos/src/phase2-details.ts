/**
 * Phase 2: Vehicle Detail Scraper
 * Visits each vehicle URL and extracts structured data.
 *
 * ⚠️ ChileAutos migró a una SPA Next.js (2026): los datos del vehículo ya NO
 * están en la variable `gallery_meta` ni en el HTML renderizado, sino dentro del
 * JSON embebido en <script id="__NEXT_DATA__">. Esta fase parsea ese blob.
 */
import { config } from './config.js';
import { fetchWithOxylabs } from './oxylabs.js';
import { log, sleep, saveCheckpoint, loadCheckpoint, deleteCheckpoint, progressBar } from './utils.js';
import { FirestoreWriter } from './firestore.js';

export interface VehicleData {
    vehiculo_id: string;
    url: string;
    marca: string;
    modelo: string;
    distintivo: string;
    ano: number;
    precio_clp: number;
    kilometraje: string;
    combustible: string;
    transmision: string;
    region: string;
    comuna: string;
    ubicacion: string;
    descripcion: string;
    titulo_completo: string;
    vendedor: string;
    motor: string;
    consumo: string;
    version: string;
    datos_incompletos: boolean;
}

// ─── __NEXT_DATA__ parsing ─────────────────────────────────────────

/**
 * Extract and parse the Next.js __NEXT_DATA__ JSON blob from page HTML.
 */
function parseNextData(html: string): any | null {
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return null;
    try {
        return JSON.parse(m[1]);
    } catch {
        return null;
    }
}

/**
 * Recursively find the first object that contains a `pageLevelTarget` key.
 * That object holds make/model/year/price/fuel/loc for the ad.
 */
function findPageLevelTarget(node: any, depth = 0): Record<string, string> | null {
    if (!node || typeof node !== 'object' || depth > 8) return null;
    if (node.pageLevelTarget && typeof node.pageLevelTarget === 'object') {
        return node.pageLevelTarget as Record<string, string>;
    }
    for (const k of Object.keys(node)) {
        const found = findPageLevelTarget(node[k], depth + 1);
        if (found) return found;
    }
    return null;
}

/**
 * Recursively find the first string/number value for a key anywhere in the tree.
 * Used for fields outside pageLevelTarget (odometermin, sellertype — csnInsights).
 */
function findFirstByKey(node: any, key: string, depth = 0): string | null {
    if (!node || typeof node !== 'object' || depth > 10) return null;
    const v = node[key];
    if (v != null && (typeof v === 'string' || typeof v === 'number')) return String(v);
    for (const k of Object.keys(node)) {
        const found = findFirstByKey(node[k], key, depth + 1);
        if (found != null) return found;
    }
    return null;
}

/** "grand cherokee" → "Grand Cherokee" */
function titleCase(s: string): string {
    return s
        .split(/\s+/)
        .filter(Boolean)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(' ');
}

/**
 * Formatea el modelo respetando la convención de la DB: tokens con dígitos van
 * en mayúscula ("xc90" → "XC90", "x1" → "X1"), el resto title-case
 * ("joyear x3" → "Joyear X3"). El sitio nuevo entrega el modelo en minúsculas.
 */
function formatModel(s: string): string {
    return s
        .split(/\s+/)
        .filter(Boolean)
        .map(w => /\d/.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(' ');
}

/** quita acentos/puntuación y espacios → clave normalizada para lookup */
function normKey(s: string): string {
    return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Las regiones del sitio nuevo vienen sin espacios ("metropolitanadesantiago").
 * Mapeamos a los nombres canónicos que ya usa la DB ("Metropolitana de Santiago").
 */
const REGION_MAP: Record<string, string> = {
    metropolitanadesantiago: 'Metropolitana de Santiago',
    valparaiso: 'Valparaíso',
    biobio: 'Biobío',
    laaraucania: 'La Araucanía', araucania: 'La Araucanía',
    loslagos: 'Los Lagos',
    losrios: 'Los Ríos',
    coquimbo: 'Coquimbo',
    ohiggins: "O'Higgins", libertadorgeneralbernardoohiggins: "O'Higgins", libertador: "O'Higgins",
    maule: 'Maule',
    antofagasta: 'Antofagasta',
    tarapaca: 'Tarapacá',
    atacama: 'Atacama',
    nuble: 'Ñuble',
    magallanes: 'Magallanes', magallanesylaantarticachilena: 'Magallanes',
    aricayparinacota: 'Arica y Parinacota',
    aysen: 'Aysén', aysendelgeneralcarlosibanezdelcampo: 'Aysén',
};

function normalizeRegion(s: string): string {
    return REGION_MAP[normKey(s)] || titleCase(s);
}

/**
 * Extract year from URL as fallback.
 * Handles: /2014-marca-modelo/ and /marca-modelo-2014/
 */
function extractYearFromUrl(url: string): number | null {
    let match = url.match(/\/(\d{4})-/);
    if (!match) match = url.match(/-(\d{4})\//);
    if (match) {
        const year = parseInt(match[1]);
        if (year >= 1900 && year <= 2027) return year;
    }
    return null;
}

/**
 * Build description string from available data
 */
function buildDescription(data: Partial<VehicleData>): string {
    const parts: string[] = [];
    if (data.marca) parts.push(`${data.marca.charAt(0).toUpperCase() + data.marca.slice(1)}`);
    if (data.modelo) parts.push(data.modelo);
    if (data.ano) parts.push(`${data.ano}`);
    const desc = parts.join(' ');

    const extras: string[] = [];
    if (data.combustible) extras.push(`motor ${data.combustible.toLowerCase()}`);
    if (data.transmision) extras.push(`transmisión ${data.transmision.toLowerCase()}`);
    if (data.kilometraje) extras.push(`con ${data.kilometraje}`);

    return extras.length > 0 ? `${desc}. ${extras.join('. ')}.` : desc;
}

/**
 * Generate a deterministic vehicle ID from its URL.
 * Uses the ChileAutos ad ID (e.g. CL-AD-12345) for stable deduplication —
 * resilient to URL slug changes between site versions.
 */
function generateVehicleId(url: string, marca: string): string {
    const adMatch = url.match(/(CL-AD-\d+|CP-AD-\d+|GI-AD-\d+)/);
    const hash = adMatch ? simpleHash(adMatch[1]) : simpleHash(url);
    return `${marca}_${hash}`;
}

function simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0;
    }
    return Math.abs(hash).toString(16).padStart(8, '0').slice(0, 8);
}

/**
 * Scrape a single vehicle detail page (Next.js __NEXT_DATA__).
 */
export async function scrapeVehicleDetail(vehicleUrl: string): Promise<VehicleData | null> {
    const html = await fetchWithOxylabs(vehicleUrl, { expectedType: 'detail' });

    if (!html) {
        log('error', `No HTML for ${vehicleUrl.slice(0, 70)}...`);
        return null;
    }

    const nextData = parseNextData(html);
    const plt = nextData ? findPageLevelTarget(nextData) : null;

    if (!plt) {
        log('warn', `Sin __NEXT_DATA__/pageLevelTarget: ${vehicleUrl.slice(0, 70)}...`);
        return null;
    }

    const marca = (plt.make || '').toLowerCase();
    const odo = findFirstByKey(nextData, 'odometermin');
    const sellertype = findFirstByKey(nextData, 'sellertype');

    const data: VehicleData = {
        vehiculo_id: generateVehicleId(vehicleUrl, marca),
        url: vehicleUrl,
        marca,
        modelo: plt.model ? formatModel(plt.model) : '',
        distintivo: '',
        ano: plt.year ? parseInt(plt.year) : 0,
        precio_clp: plt.price ? parseInt(String(plt.price).replace(/[^\d]/g, '')) : 0,
        kilometraje: '',
        combustible: plt.fuel ? titleCase(plt.fuel) : '',
        transmision: '', // no expuesto en __NEXT_DATA__ del sitio nuevo
        vendedor: sellertype ? titleCase(sellertype) : '',
        motor: '',
        consumo: '',
        version: plt.ver || '',
        titulo_completo: '',
        descripcion: '',
        region: plt.loc ? normalizeRegion(plt.loc) : '',
        comuna: plt.subloc ? titleCase(plt.subloc) : '',
        ubicacion: plt.loc || '',
        datos_incompletos: false,
    };

    // Fallback: year from URL
    if (!data.ano || data.ano === 0) {
        const yearFromUrl = extractYearFromUrl(vehicleUrl);
        if (yearFromUrl) data.ano = yearFromUrl;
    }

    // Format kilometraje to DB convention ("18.000 km")
    if (odo) {
        const kmNum = parseInt(String(odo).replace(/[^\d]/g, ''));
        if (kmNum > 0) data.kilometraje = `${kmNum.toLocaleString('es-CL')} km`;
    }

    data.titulo_completo = `${data.marca} ${data.modelo}${data.ano ? ` ${data.ano}` : ''}`;
    data.descripcion = buildDescription(data);
    data.datos_incompletos = !data.marca || !data.precio_clp || data.precio_clp === 0;

    return data;
}

/**
 * Procesa un lote de URLs de vehículos (Phase 2)
 * Con dedup: carga URLs existentes de Firestore y salta los ya scrapeados.
 */
export async function scrapeVehicleDetails(
    urls: string[],
    options: { saveToFirestore?: boolean; batchName?: string } = {}
): Promise<{ results: VehicleData[]; errors: string[]; skippedDedup: number }> {
    const { saveToFirestore = true, batchName = 'phase2' } = options;

    const checkpointId = `phase2_${batchName}`;
    const existing = loadCheckpoint(checkpointId);
    const processedUrls = new Set<string>(existing?.processedUrls || []);

    // ── Dedup: filtra URLs que ya existen en Firestore ──
    const firestore = saveToFirestore ? new FirestoreWriter() : null;
    let existingDbUrls = new Set<string>();
    let skippedDedup = 0;

    if (firestore) {
        existingDbUrls = await firestore.loadExistingUrls();
    }

    // Filter out checkpoint-processed + Firestore-existing URLs
    const pendingUrls = urls.filter(u => {
        if (processedUrls.has(u)) return false;
        if (existingDbUrls.has(u)) {
            skippedDedup++;
            return false;
        }
        return true;
    });

    log('info', `═══════════════════════════════════════════════════`);
    log('info', `PHASE 2 — ${urls.length} URLs totales`);
    if (skippedDedup > 0) {
        log('info', `🔄 Dedup: ${skippedDedup} ya existen en DB → saltados`);
    }
    if (processedUrls.size > 0) {
        log('info', `📋 Checkpoint: ${processedUrls.size} ya procesados`);
    }
    log('info', `🆕 Por scrapear: ${pendingUrls.length} URLs nuevas`);
    log('info', `═══════════════════════════════════════════════════`);

    if (pendingUrls.length === 0) {
        log('info', '✅ Nada nuevo por scrapear — todo ya está en Firestore');
        return { results: [], errors: [], skippedDedup };
    }

    const results: VehicleData[] = [];
    const errors: string[] = [];
    const startTime = Date.now();

    for (let i = 0; i < pendingUrls.length; i++) {
        const url = pendingUrls[i];

        console.log(`\n${progressBar(i + 1, pendingUrls.length)}`);
        log('info', `Scraping: ${url.slice(0, 80)}...`);

        try {
            const data = await scrapeVehicleDetail(url);

            if (data) {
                results.push(data);

                // Guardar en Firestore inmediatamente
                if (firestore) {
                    await firestore.putVehicle(data);
                }

                const fields = [data.marca, data.modelo, data.ano, `$${data.precio_clp?.toLocaleString('es-CL')}`].filter(Boolean);
                log('info', `→ ${fields.join(' | ')}`);
            } else {
                errors.push(url);
            }

            processedUrls.add(url);

            // Save checkpoint every 5 vehicles
            if ((i + 1) % 5 === 0) {
                saveCheckpoint(checkpointId, {
                    phase: 'phase2',
                    processedUrls: Array.from(processedUrls),
                    completedCount: processedUrls.size,
                    totalUrls: urls.length,
                    updatedAt: new Date().toISOString(),
                });
            }

        } catch (err) {
            log('error', `Exception: ${err instanceof Error ? err.message : String(err)}`);
            errors.push(url);
        }

        // Delay between requests (with jitter ±20%)
        if (i < pendingUrls.length - 1) {
            const baseDelay = config.scraping.delayBetweenDetailsMs;
            const jitteredDelay = Math.round(baseDelay + baseDelay * 0.2 * (Math.random() * 2 - 1));
            await sleep(jitteredDelay);
        }
    }

    const elapsed = (Date.now() - startTime) / 1000;
    const rate = results.length / (elapsed / 60);

    log('info', `═══════════════════════════════════════════════════`);
    log('info', `PHASE 2 COMPLETADA`);
    log('info', `✅ Procesados: ${results.length}/${pendingUrls.length}`);
    log('info', `❌ Errores: ${errors.length}`);
    log('info', `⏱  Tiempo: ${(elapsed / 60).toFixed(1)} min (${rate.toFixed(1)} veh/min)`);
    if (firestore) {
        log('info', `💾 Firestore: ${results.length} guardados`);
    }
    log('info', `═══════════════════════════════════════════════════`);

    deleteCheckpoint(checkpointId);

    return { results, errors, skippedDedup };
}
