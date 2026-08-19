/**
 * check_duplicates.cjs
 * Detecta y elimina documentos duplicados en Firestore.
 * La clave única es vehiculo_id (= URL del vehículo).
 * 
 * Uso:
 *   node check_duplicates.cjs           → solo reporta
 *   node check_duplicates.cjs --fix     → elimina duplicados
 */

const { Firestore } = require('@google-cloud/firestore');
const path = require('path');

process.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(__dirname, '../scraper-sa-key.json');

const db = new Firestore({ projectId: 'espi-ia-491115' });
const COLLECTION = 'chileautos_vehiculos';
const FIX_MODE = process.argv.includes('--fix');

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  DETECCIÓN DE DUPLICADOS — Firestore');
  console.log('  Modo: ' + (FIX_MODE ? '🔧 FIX (eliminar duplicados)' : '🔍 CHECK (solo reportar)'));
  console.log('═══════════════════════════════════════════════════\n');

  const col = db.collection(COLLECTION);

  // ── Paso 1: Contar total ──────────────────────────────────────
  log('📊 Contando documentos totales...');
  const total = (await col.select('vehiculo_id', 'url').get());
  log(`   Total docs en Firestore: ${total.size.toLocaleString('es-CL')}`);

  // ── Paso 2: Detectar duplicados por vehiculo_id ───────────────
  log('\n🔍 Analizando duplicados por vehiculo_id...');
  
  const idMap = {}; // id → [docId1, docId2, ...]
  const noId  = []; // docs sin vehiculo_id

  total.docs.forEach(doc => {
    const data = doc.data();
    const vid = data.vehiculo_id || data.url;
    if (!vid) {
      noId.push(doc.id);
      return;
    }
    if (!idMap[vid]) idMap[vid] = [];
    idMap[vid].push(doc.id);
  });

  // ── Paso 3: Analizar resultados ───────────────────────────────
  const duplicateGroups = Object.entries(idMap).filter(([, ids]) => ids.length > 1);
  const totalDuplicateDocs = duplicateGroups.reduce((sum, [, ids]) => sum + ids.length - 1, 0);
  const uniqueCount = Object.keys(idMap).length;

  log(`\n📋 RESULTADOS:`);
  log(`   Docs únicos (por vehiculo_id):  ${uniqueCount.toLocaleString('es-CL')}`);
  log(`   Grupos con duplicados:         ${duplicateGroups.length.toLocaleString('es-CL')}`);
  log(`   Docs duplicados a eliminar:    ${totalDuplicateDocs.toLocaleString('es-CL')}`);
  log(`   Docs sin vehiculo_id:          ${noId.length}`);

  if (duplicateGroups.length === 0) {
    log('\n✅ ¡Sin duplicados! La base está limpia.');
    process.exit(0);
  }

  // ── Paso 4: Mostrar muestra de duplicados ────────────────────
  log('\n📌 Muestra de los primeros 10 grupos duplicados:');
  duplicateGroups.slice(0, 10).forEach(([vid, ids], i) => {
    log(`   ${i+1}. ${vid.slice(0, 60)}...`);
    log(`      → ${ids.length} copias: ${ids.join(', ')}`);
  });

  // ── Paso 5: Eliminar si --fix ────────────────────────────────
  if (!FIX_MODE) {
    log('\n⚠️  Para eliminar duplicados, ejecuta con: node check_duplicates.cjs --fix');
    process.exit(0);
  }

  log(`\n🔧 Eliminando ${totalDuplicateDocs.toLocaleString()} duplicados...`);
  let deleted = 0;
  let batchNum = 0;
  
  // Procesar en mini-batches de 400
  const toDelete = [];
  duplicateGroups.forEach(([, ids]) => {
    // Mantener el primero, eliminar el resto
    ids.slice(1).forEach(docId => toDelete.push(docId));
  });

  for (let i = 0; i < toDelete.length; i += 400) {
    const chunk = toDelete.slice(i, i + 400);
    const batch = db.batch();
    chunk.forEach(docId => batch.delete(col.doc(docId)));
    await batch.commit();
    deleted += chunk.length;
    batchNum++;
    if (batchNum % 5 === 0) {
      log(`   🗑️  Eliminados: ${deleted.toLocaleString()} / ${toDelete.length.toLocaleString()}`);
    }
    await sleep(100);
  }

  log(`\n✅ LIMPIEZA COMPLETA`);
  log(`   Documentos eliminados: ${deleted.toLocaleString()}`);
  log(`   Total final en Firestore: ~${(total.size - deleted).toLocaleString('es-CL')}`);
  process.exit(0);
}

main().catch(e => {
  console.error('❌ Error:', e.message);
  process.exit(1);
});
