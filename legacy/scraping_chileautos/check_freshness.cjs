/**
 * check_freshness.cjs — Mide qué tan actualizada está la colección Firestore.
 * Read-only. Uso: node check_freshness.cjs
 */
const { Firestore } = require('@google-cloud/firestore');

const COLLECTION = process.env.FIRESTORE_COLLECTION || 'chileautos_vehiculos';
const db = new Firestore({
  projectId: 'espi-ia-491115',
  keyFilename: require('path').resolve(__dirname, '../scraper-sa-key.json'),
});

(async () => {
  const col = db.collection(COLLECTION);

  // Documento más reciente por timestamp
  console.log('🔎 Buscando los 5 docs más recientes por timestamp...');
  const recent = await col.orderBy('timestamp', 'desc').limit(5).get();
  console.log(`\n📅 ÚLTIMAS EXTRACCIONES (timestamp):`);
  recent.docs.forEach(d => {
    const x = d.data();
    console.log(`  ${x.timestamp}  ${x.marca}/${x.modelo} ${x.ano}  estado=${x.estado}`);
  });

  // Más antiguo verificado
  const oldest = await col.orderBy('fecha_ultima_verificacion', 'asc').limit(3).get();
  console.log(`\n🕰  MÁS ANTIGUOS sin re-verificar (fecha_ultima_verificacion):`);
  oldest.docs.forEach(d => {
    const x = d.data();
    console.log(`  ${x.fecha_ultima_verificacion}  ${x.marca}/${x.modelo} ${x.ano}  estado=${x.estado}`);
  });

  // Conteo por estado (count aggregation — barato)
  console.log(`\n📊 CONTEO POR ESTADO (aggregation):`);
  for (const estado of ['active', 'delisted']) {
    const c = await col.where('estado', '==', estado).count().get();
    console.log(`  ${estado}: ${c.data().count.toLocaleString()}`);
  }
  const total = await col.count().get();
  console.log(`  TOTAL: ${total.data().count.toLocaleString()}`);

  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
