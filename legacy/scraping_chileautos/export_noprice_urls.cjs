/**
 * export_noprice_urls.cjs
 * Exporta todas las URLs de vehículos sin precio desde Firestore
 * para re-scraping dirigido.
 */
const { Firestore } = require('@google-cloud/firestore');
const fs = require('fs');
const path = require('path');

process.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(__dirname, '../scraper-sa-key.json');
const db = new Firestore({ projectId: 'espi-ia-491115' });

async function main() {
  console.log('🔍 Buscando vehículos sin precio en Firestore...');

  const snap = await db.collection('chileautos_vehiculos')
    .where('precio_clp', '==', 0)
    .select('marca', 'modelo', 'ano', 'url', 'vehiculo_id')
    .get();

  console.log(`📊 Total sin precio: ${snap.size}`);

  // Agrupar por marca
  const byBrand = {};
  const allUrls = [];

  snap.docs.forEach(d => {
    const data = d.data();
    const url = data.url || data.vehiculo_id;
    const marca = (data.marca || 'unknown').toLowerCase();
    if (!url) return;

    if (!byBrand[marca]) byBrand[marca] = [];
    byBrand[marca].push(url);
    allUrls.push(url);
  });

  // Guardar todas las URLs en un archivo para el retry
  const outputFile = path.join(__dirname, 'noprice_urls.txt');
  fs.writeFileSync(outputFile, allUrls.join('\n'));
  console.log(`✅ ${allUrls.length} URLs guardadas en: ${outputFile}`);

  // Mostrar resumen por marca
  console.log('\n📋 Por marca:');
  Object.entries(byBrand)
    .sort((a, b) => b[1].length - a[1].length)
    .forEach(([m, urls]) => console.log(`  ${m}: ${urls.length}`));

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
