/**
 * CLI Orchestrator for ChileAutos Scraper
 * 
 * Usage:
 *   tsx src/cli.ts phase1 --brand ford
 *   tsx src/cli.ts phase1 --all
 *   tsx src/cli.ts phase2 --input output/urls_ford_2026-02-13.json
 *   tsx src/cli.ts full --brand maserati
 *   tsx src/cli.ts stats
 *   tsx src/cli.ts distribute --workers 6
 *   tsx src/cli.ts update --brands chevrolet,ford --vps-id 1
 */
import { validateConfig } from './config.js';
import { BRANDS, getBrand, distributeBrands, filterBrands } from './brands.js';
import { extractUrlsByBrand, extractUrlsForBrands } from './phase1-urls.js';
import { scrapeVehicleDetails } from './phase2-details.js';
import { FirestoreWriter } from './firestore.js';
import { runUpdate } from './update.js';
import { log, loadOutput } from './utils.js';
import fs from 'fs';

// ─── Parse CLI args ──────────────────────────────────────────────────
function parseArgs(): { command: string; flags: Record<string, string> } {
    const args = process.argv.slice(2);
    const command = args[0] || 'help';
    const flags: Record<string, string> = {};

    for (let i = 1; i < args.length; i++) {
        if (args[i].startsWith('--')) {
            const key = args[i].slice(2);
            const value = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : 'true';
            flags[key] = value;
            if (value !== 'true') i++;
        }
    }

    return { command, flags };
}

// ─── Commands ────────────────────────────────────────────────────────

async function cmdPhase1(flags: Record<string, string>) {
    validateConfig();

    if (flags.all) {
        // All brands
        await extractUrlsForBrands(BRANDS);
    } else if (flags.brand) {
        // Single brand
        const brand = getBrand(flags.brand);
        if (!brand) {
            console.error(`❌ Brand not found: ${flags.brand}`);
            console.log(`Available brands: ${BRANDS.map(b => b.slug).join(', ')}`);
            process.exit(1);
        }
        await extractUrlsByBrand(brand);
    } else if (flags.brands) {
        // Comma-separated brands
        const slugs = flags.brands.split(',').map(s => s.trim());
        const brands = slugs.map(slug => {
            const b = getBrand(slug);
            if (!b) {
                console.error(`❌ Unknown brand: ${slug}`);
                process.exit(1);
            }
            return b!;
        });
        await extractUrlsForBrands(brands);
    } else {
        console.error('❌ Specify --brand <name>, --brands <name1,name2>, or --all');
        process.exit(1);
    }
}

async function cmdPhase2(flags: Record<string, string>) {
    validateConfig();

    if (!flags.input) {
        console.error('❌ Specify --input <path to URLs JSON>');
        process.exit(1);
    }

    // Load URLs from file
    let urls: string[];

    try {
        const raw = fs.readFileSync(flags.input, 'utf-8');
        const data = JSON.parse(raw);

        if (Array.isArray(data)) {
            // Simple array of URLs
            urls = data;
        } else if (data.urls) {
            // Phase1 output format
            urls = data.urls;
        } else {
            console.error('❌ Unrecognized JSON format. Expected array of URLs or {urls: [...]}');
            process.exit(1);
        }
    } catch (err) {
        console.error(`❌ Error loading ${flags.input}: ${err}`);
        process.exit(1);
    }

    const batchName = flags.name || flags.input.replace(/[^a-zA-Z0-9]/g, '_');
    const noFirestore = flags['no-firestore'] === 'true';

    log('info', `Loaded ${urls.length} URLs from ${flags.input}`);

    await scrapeVehicleDetails(urls, {
        saveToFirestore: !noFirestore,
        batchName,
    });
}

async function cmdFull(flags: Record<string, string>) {
    validateConfig();

    if (!flags.brand) {
        console.error('❌ Specify --brand <name>');
        process.exit(1);
    }

    const brand = getBrand(flags.brand);
    if (!brand) {
        console.error(`❌ Brand not found: ${flags.brand}`);
        process.exit(1);
    }

    log('info', `═══════════════════════════════════════════════════`);
    log('info', `FULL PIPELINE for ${brand.name}`);
    log('info', `═══════════════════════════════════════════════════`);

    // Phase 1: collect URLs
    log('info', `Phase 1: Collecting URLs...`);
    const phase1 = await extractUrlsByBrand(brand);

    if (phase1.urls.length === 0) {
        log('warn', `No URLs found for ${brand.name}, stopping`);
        return;
    }

    log('info', `Phase 1 done: ${phase1.urls.length} URLs`);

    // Phase 2: scrape details
    log('info', `Phase 2: Scraping details...`);
    const noFirestore = flags['no-firestore'] === 'true';

    await scrapeVehicleDetails(phase1.urls, {
        saveToFirestore: !noFirestore,
        batchName: brand.slug,
    });

    log('info', `═══════════════════════════════════════════════════`);
    log('info', `FULL PIPELINE COMPLETE for ${brand.name}`);
    log('info', `═══════════════════════════════════════════════════`);
}

async function cmdStats() {
    validateConfig();
    const firestore = new FirestoreWriter();
    log('info', 'Obteniendo estadísticas de Firestore...');
    const stats = await firestore.getStats();

    console.log(`\n📊 FIRESTORE STATS`);
    console.log(`Total items: ${stats.totalItems.toLocaleString()}`);
    console.log(`\nMarcas:`);

    const sorted = Object.entries(stats.brands).sort((a, b) => b[1] - a[1]);
    for (const [brand, count] of sorted) {
        console.log(`  ${brand}: ${count}`);
    }
}

function cmdDistribute(flags: Record<string, string>) {
    const workers = parseInt(flags.workers || '6');
    const minCount = parseInt(flags['min-count'] || '0');
    const buckets = distributeBrands(workers, minCount);

    const totalVehicles = buckets.reduce((sum, w) => sum + w.totalVehicles, 0);
    const totalBrands = buckets.reduce((sum, w) => sum + w.brands.length, 0);

    console.log(`\n🖥️  Brand distribution across ${workers} VPS`);
    console.log(`📊 Total: ${totalBrands} brands, ${totalVehicles.toLocaleString()} vehicles`);
    if (minCount > 0) console.log(`🔽 Min count filter: ${minCount}`);
    console.log(`${'─'.repeat(60)}\n`);

    buckets.forEach(worker => {
        const pct = ((worker.totalVehicles / totalVehicles) * 100).toFixed(1);
        console.log(`  VPS ${worker.workerId} — ${worker.totalVehicles.toLocaleString()} veh (${pct}%) — ${worker.brands.length} brands`);
        const names = worker.brands.map(b => `${b.slug}(${b.count})`).join(', ');
        console.log(`    ${names}\n`);
    });

    // Generate config files for each VPS
    console.log(`${'─'.repeat(60)}`);
    buckets.forEach(worker => {
        const config = {
            vps_id: worker.workerId,
            total_vehicles: worker.totalVehicles,
            brands: worker.brands.map(b => ({ name: b.name, slug: b.slug, count: b.count })),
        };
        const filename = `config_vps_${worker.workerId}.json`;
        fs.writeFileSync(filename, JSON.stringify(config, null, 2));
        console.log(`  📝 Saved: ${filename} (${worker.brands.length} brands, ${worker.totalVehicles.toLocaleString()} veh)`);
    });
}

// ─── Update Command ──────────────────────────────────────────────────
async function cmdUpdate(flags: Record<string, string>) {
    validateConfig();

    const brands = flags.brands ? flags.brands.split(',').map(s => s.trim()) : undefined;
    const vpsId = flags['vps-id'] ? parseInt(flags['vps-id']) : undefined;
    const skipPhase1 = flags['skip-phase1'] === 'true';
    const skipDelisted = flags['skip-delisted'] === 'true';

    await runUpdate({
        brands,
        vpsId,
        skipPhase1,
        skipDelisted,
    });
}

function showHelp() {
    console.log(`
🚗 ChileAutos Scraper v2 (TypeScript)

USAGE:
  npx tsx src/cli.ts <command> [options]

COMMANDS:
  phase1      Collect vehicle URLs from listings
              --brand <name>              Single brand
              --brands <name1,name2>      Multiple brands
              --all                       All brands

  phase2      Scrape vehicle details from URLs
              --input <file.json>         JSON file with URLs
              --name <batch_name>         Name for checkpoint tracking
              --no-firestore              Skip Firestore writes (dry run)

  full        Run phase1 + phase2 for a brand
              --brand <name>              Brand to scrape
              --no-firestore              Skip Firestore writes

  update      Incremental update (Phase1 → Diff → Phase2 → Mark delisted)
              --brands <name1,name2>      Brands to process (default: all)
              --vps-id <N>                VPS identifier for logging
              --skip-phase1               Skip URL collection, use existing files
              --skip-delisted             Skip marking delisted vehicles

  stats       Show Firestore collection statistics

  distribute  Split brands across VPS workers
              --workers <N>               Number of VPS (default: 6)

  help        Show this help message

EXAMPLES:
  npx tsx src/cli.ts phase1 --brand maserati
  npx tsx src/cli.ts phase2 --input output/urls_maserati_2026-02-13.json
  npx tsx src/cli.ts full --brand maserati
  npx tsx src/cli.ts update --brands chevrolet,ford,toyota --vps-id 1
  npx tsx src/cli.ts update --vps-id 2  (all brands)
  npx tsx src/cli.ts stats
  npx tsx src/cli.ts distribute --workers 6

ENVIRONMENT:
  Copy .env.example to .env and configure:
  - OXYLABS_USERNAME / OXYLABS_PASSWORD
  - GCP_PROJECT_ID (your Google Cloud project ID)
  - GCP_KEY_FILE   (optional: path to service account JSON)
`);
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
    const { command, flags } = parseArgs();

    switch (command) {
        case 'phase1':
            await cmdPhase1(flags);
            break;
        case 'phase2':
            await cmdPhase2(flags);
            break;
        case 'full':
            await cmdFull(flags);
            break;
        case 'update':
            await cmdUpdate(flags);
            break;
        case 'stats':
            await cmdStats();
            break;
        case 'distribute':
            cmdDistribute(flags);
            break;
        case 'help':
        default:
            showHelp();
            break;
    }
}

main().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});
