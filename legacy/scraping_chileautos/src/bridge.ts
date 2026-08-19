/**
 * Bridge: puente manual phase1 (token AWS WAF) → phase2 → Firestore.
 *
 * ChileAutos (SPA Merlin 2026) protege /_api/search-core con un token de AWS WAF
 * que OxyLabs no resuelve. La vía que SÍ funciona: pedir el filtro como DOCUMENTO
 * desde la misma IP del browser del usuario, con un aws-waf-token + datadome frescos.
 * El SSR de esa request incluye los <a href="/vehiculos/detalles/..."> reales.
 *
 * Este script NO genera el token (no se puede). Recibe el HTML ya descargado con
 * ese token y se encarga del resto: extraer URLs de detalle → phase2 (OxyLabs, que
 * sí sirve para detalle) → upload a Firestore con putVehicle directo (sin dedup-skip,
 * para forzar update de precios/km).
 *
 * Flujo de uso:
 *   1. En el browser del user, filtrar el modelo: /vehiculos/?q=(C.Marca.<Marca>._.Modelo.<Modelo>.)
 *      (⚠️ NO agregar ._.Ano. ni ._.Page. → rompen el filtro; se filtra año/página acá).
 *   2. "Copy as cURL" de esa navegación (o de cualquier request que lleve el cookie jar).
 *   3. Correr ese cURL desde la Mac (misma IP) volcando a un archivo .html.
 *   4. npx tsx src/bridge.ts --html <archivo.html> [--year 2019] [--model xc90] [--no-firestore]
 *
 * El token caduca en minutos → hacer 2-3 rápido.
 */
import * as fs from 'fs';
import * as cheerio from 'cheerio';
import { config } from './config.js';
import { scrapeVehicleDetail } from './phase2-details.js';
import { FirestoreWriter } from './firestore.js';
import { log, sleep } from './utils.js';

interface BridgeArgs {
    htmlFile: string;
    year?: number;
    model?: string;
    saveToFirestore: boolean;
}

function parseArgs(argv: string[]): BridgeArgs {
    const args: BridgeArgs = { htmlFile: '', saveToFirestore: true };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--html') args.htmlFile = argv[++i];
        else if (a === '--year') args.year = parseInt(argv[++i], 10);
        else if (a === '--model') args.model = argv[++i].toLowerCase();
        else if (a === '--no-firestore') args.saveToFirestore = false;
    }
    if (!args.htmlFile) {
        console.error('Uso: npx tsx src/bridge.ts --html <archivo.html> [--year YYYY] [--model slug] [--no-firestore]');
        process.exit(1);
    }
    return args;
}

/**
 * Extrae URLs de detalle del HTML SSR. Mismo criterio que phase1: todos los
 * anchors a /vehiculos/detalles/, sin query/fragment, normalizados a https.
 */
function extractDetailUrls(html: string): string[] {
    const $ = cheerio.load(html);
    const collected = new Set<string>();
    $('a[href*="/vehiculos/detalles/"]').each((_, el) => {
        const href = $(el).attr('href');
        if (!href) return;
        const clean = href.split('?')[0].split('#')[0];
        const fullUrl = clean.startsWith('http') ? clean : `${config.chileautos.baseUrl}${clean}`;
        collected.add(fullUrl);
    });
    return [...collected];
}

/** Extrae el año del slug de la URL: /2019-marca-modelo/ o /marca-modelo-2019/ */
function yearFromUrl(url: string): number | null {
    let m = url.match(/\/(\d{4})-/);
    if (!m) m = url.match(/-(\d{4})\//);
    if (m) {
        const y = parseInt(m[1], 10);
        if (y >= 1900 && y <= 2027) return y;
    }
    return null;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    if (!fs.existsSync(args.htmlFile)) {
        log('error', `No existe el archivo: ${args.htmlFile}`);
        process.exit(1);
    }
    const html = fs.readFileSync(args.htmlFile, 'utf8');
    log('info', `📄 HTML leído: ${(html.length / 1024).toFixed(0)} KB`);

    let urls = extractDetailUrls(html);
    log('info', `🔗 URLs de detalle en el SSR: ${urls.length}`);

    if (urls.length === 0) {
        log('warn', '⚠️ 0 URLs de detalle. El token venció, o el HTML es el carrusel promocionado en vez del filtro. Recaptura el cURL.');
        process.exit(1);
    }

    // Filtros opcionales sobre el slug
    if (args.model) {
        urls = urls.filter(u => u.toLowerCase().includes(args.model!));
        log('info', `   ↳ filtro modelo "${args.model}": ${urls.length}`);
    }
    if (args.year) {
        urls = urls.filter(u => yearFromUrl(u) === args.year);
        log('info', `   ↳ filtro año ${args.year}: ${urls.length}`);
    }

    if (urls.length === 0) {
        log('warn', '⚠️ Ningún resultado tras filtrar. Revisa --model/--year.');
        process.exit(0);
    }

    log('info', `═══════════════════════════════════════════════════`);
    log('info', `BRIDGE → phase2 de ${urls.length} URLs (Firestore: ${args.saveToFirestore ? 'sí' : 'no'})`);
    log('info', `═══════════════════════════════════════════════════`);

    // phase2 vía OxyLabs + putVehicle directo (sin dedup-skip → fuerza update)
    const firestore = args.saveToFirestore ? new FirestoreWriter() : null;
    const ok: string[] = [];
    const fail: string[] = [];

    for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        log('info', `[${i + 1}/${urls.length}] ${url.slice(0, 80)}...`);
        try {
            const data = await scrapeVehicleDetail(url);
            if (!data) { fail.push(url); continue; }
            if (firestore) await firestore.putVehicle(data);
            ok.push(url);
            log('info', `   → ${data.marca} ${data.modelo} ${data.ano} | $${data.precio_clp.toLocaleString('es-CL')} | ${data.kilometraje} | ${data.region}`);
        } catch (err) {
            log('error', `   ✗ ${err instanceof Error ? err.message : String(err)}`);
            fail.push(url);
        }
        if (i < urls.length - 1) {
            const base = config.scraping.delayBetweenDetailsMs;
            await sleep(Math.round(base + base * 0.2 * (Math.random() * 2 - 1)));
        }
    }

    log('info', `═══════════════════════════════════════════════════`);
    log('info', `BRIDGE COMPLETADO — ✅ ${ok.length}  ❌ ${fail.length}  (de ${urls.length})`);
    if (firestore) log('info', `💾 ${ok.length} escritos en Firestore (${config.firestore.collectionName})`);
    if (fail.length) log('warn', `URLs fallidas:\n${fail.join('\n')}`);
    log('info', `═══════════════════════════════════════════════════`);
}

main().catch(err => {
    log('error', `Bridge fatal: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
});
