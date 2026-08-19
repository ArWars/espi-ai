/**
 * split_noprice_vps.cjs
 * Divide las URLs sin precio en 6 lotes para enviar a cada VPS
 * y genera los archivos JSON en el formato que espera phase2
 */

const { Firestore } = require('@google-cloud/firestore');
const fs = require('fs');
const path = require('path');

process.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(__dirname, '../scraper-sa-key.json');
const db = new Firestore({ projectId: 'espi-ia-491115' });

const NUM_VPS = 6;
const OUTPUT_DIR = path.join(__dirname, 'output');

async function main() {
  console.log('🔍 Obteniendo vehículos sin precio de Firestore...');

  const snap = await db.collection('chileautos_vehiculos')
    .where('precio_clp', '==', 0)
    .select('marca', 'modelo', 'ano', 'url', 'vehiculo_id')
    .get();

  console.log(`📊 Total sin precio: ${snap.size}`);

  // Construir lista de URLs en formato que espera phase2
  const urls = [];
  snap.docs.forEach(d => {
    const data = d.data();
    const url = data.url || data.vehiculo_id;
    if (url && url.startsWith('http')) {
      urls.push({
        url,
        marca: data.marca || 'unknown',
        modelo: data.modelo || '',
        ano: data.ano || 0,
      });
    }
  });

  console.log(`✅ ${urls.length} URLs válidas para retry`);

  // Crear directorio output si no existe
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // Dividir en 6 lotes balanceados
  const chunkSize = Math.ceil(urls.length / NUM_VPS);
  const timestamp = new Date().toISOString().slice(0, 10);

  for (let i = 0; i < NUM_VPS; i++) {
    const chunk = urls.slice(i * chunkSize, (i + 1) * chunkSize);
    if (chunk.length === 0) continue;

    const filename = `urls_noprice_vps${i + 1}_${timestamp}.json`;
    const filepath = path.join(OUTPUT_DIR, filename);
    fs.writeFileSync(filepath, JSON.stringify(chunk, null, 2));

    console.log(`  📁 VPS ${i + 1}: ${chunk.length} URLs → ${filename}`);
  }

  console.log('\n✅ Archivos listos. Para enviar a cada VPS:');
  for (let i = 1; i <= NUM_VPS; i++) {
    const filename = `urls_noprice_vps${i}_${timestamp}.json`;
    console.log(`  VPS ${i}: scp output/${filename} root@VPS_IP:/root/scraping_chileautos/output/${filename}`);
  }

  process.exit(0);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
