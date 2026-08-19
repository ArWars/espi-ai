/**
 * migrate_dynamo_to_firestore.cjs
 * Exporta toda la tabla DynamoDB "chileautos_vehiculos"
 * y la importa a Firestore (GCP) en batches de 400.
 *
 * Uso: node migrate_dynamo_to_firestore.cjs
 * Requiere: AWS CLI configurado + scraper-sa-key.json
 */

const { DynamoDBClient, ScanCommand } = require('@aws-sdk/client-dynamodb');
const { unmarshall } = require('@aws-sdk/util-dynamodb');
const { Firestore } = require('@google-cloud/firestore');
const fs = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────
process.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(__dirname, '../scraper-sa-key.json');

const DYNAMO_TABLE  = 'chileautos_vehiculos';
const DYNAMO_REGION = 'us-east-1';
const FIRESTORE_PROJECT    = 'espi-ia-491115';
const FIRESTORE_COLLECTION = 'chileautos_vehiculos';
const BATCH_SIZE = 400;
const BACKUP_FILE = path.join(__dirname, 'dynamo_backup.jsonl');

// ── Clientes ──────────────────────────────────────────────────────
const dynamo   = new DynamoDBClient({ region: DYNAMO_REGION });
const firestore = new Firestore({ projectId: FIRESTORE_PROJECT });

// ── Helpers ───────────────────────────────────────────────────────
function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── PASO 1: Exportar DynamoDB → archivo JSONL (backup) ───────────
async function exportDynamo() {
  log(`📦 Iniciando export de DynamoDB "${DYNAMO_TABLE}"...`);

  const writeStream = fs.createWriteStream(BACKUP_FILE);
  let totalItems = 0;
  let lastKey = undefined;
  let page = 0;

  do {
    page++;
    const cmd = new ScanCommand({
      TableName: DYNAMO_TABLE,
      ExclusiveStartKey: lastKey,
    });

    const res = await dynamo.send(cmd);
    const items = (res.Items || []).map(item => unmarshall(item));

    for (const item of items) {
      writeStream.write(JSON.stringify(item) + '\n');
    }

    totalItems += items.length;
    lastKey = res.LastEvaluatedKey;

    if (page % 10 === 0) {
      log(`  📄 Página ${page} — ${totalItems.toLocaleString()} items exportados...`);
    }
  } while (lastKey);

  writeStream.end();
  log(`✅ Export completo: ${totalItems.toLocaleString()} items → ${BACKUP_FILE}`);
  return totalItems;
}

// ── PASO 2: Importar JSONL → Firestore ───────────────────────────
async function importToFirestore() {
  log(`\n🔥 Iniciando import a Firestore "${FIRESTORE_COLLECTION}"...`);

  const lines = fs.readFileSync(BACKUP_FILE, 'utf8').trim().split('\n');
  log(`  📊 Total a importar: ${lines.length.toLocaleString()} items`);

  const col = firestore.collection(FIRESTORE_COLLECTION);
  const now = new Date().toISOString();
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  let batchNum = 0;

  for (let i = 0; i < lines.length; i += BATCH_SIZE) {
    const chunk = lines.slice(i, i + BATCH_SIZE);
    const batch = firestore.batch();
    batchNum++;

    for (const line of chunk) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        const id = item.vehiculo_id || item.url || `dynamo_${i}`;

        // Normalizar y enriquecer el documento
        const doc = {
          ...item,
          vehiculo_id: id,
          marca: (item.marca || 'unknown').toLowerCase(),
          modelo: item.modelo || '',
          ano: Number(item.ano) || 0,
          precio_clp: Number(item.precio_clp) || 0,
          estado: item.estado || 'active',
          migrated_from: 'dynamodb',
          migrated_at: now,
        };

        batch.set(col.doc(id), doc, { merge: true });
        imported++;
      } catch (e) {
        skipped++;
      }
    }

    try {
      await batch.commit();
      if (batchNum % 5 === 0) {
        log(`  📤 Batch ${batchNum}: ${imported.toLocaleString()} importados...`);
      }
    } catch (e) {
      log(`  ❌ Batch ${batchNum} falló: ${e.message}`);
      failed += chunk.length;
      imported -= chunk.length;
    }

    // Pausa entre batches para no saturar Firestore
    await sleep(100);
  }

  log(`\n✅ MIGRACIÓN COMPLETA`);
  log(`  📥 Importados: ${imported.toLocaleString()}`);
  log(`  ⚠️  Skipped:   ${skipped}`);
  log(`  ❌ Fallidos:   ${failed}`);
  return imported;
}

// ── MAIN ──────────────────────────────────────────────────────────
async function main() {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  MIGRACIÓN DynamoDB → Firestore');
  console.log('  Tabla:      ' + DYNAMO_TABLE);
  console.log('  Proyecto:   ' + FIRESTORE_PROJECT);
  console.log('  Colección:  ' + FIRESTORE_COLLECTION);
  console.log('═══════════════════════════════════════════════════\n');

  const args = process.argv.slice(2);

  if (args[0] === '--only-export') {
    await exportDynamo();
  } else if (args[0] === '--only-import') {
    if (!fs.existsSync(BACKUP_FILE)) {
      console.error('❌ No existe el backup. Ejecuta sin --only-import primero.');
      process.exit(1);
    }
    await importToFirestore();
  } else {
    // Full: export + import
    await exportDynamo();
    await importToFirestore();
  }

  process.exit(0);
}

main().catch(e => {
  console.error('❌ Error fatal:', e.message);
  process.exit(1);
});
