/**
 * probe_oxylabs.cjs — diagnostico del fetch de chileautos via OxyLabs.
 * Escribe resultado en /tmp/probe.out
 */
require('dotenv').config({ path: '/root/scraping_chileautos/.env' });
const U = process.env.OXYLABS_USERNAME, P = process.env.OXYLABS_PASSWORD;
const auth = 'Basic ' + Buffer.from(U + ':' + P).toString('base64');
const q = encodeURIComponent('(And.Servicio.chileautos._.Marca.Maserati.)');
const listUrl = `https://www.chileautos.cl/vehiculos/?q=${q}`;

async function probe(label, payload) {
  try {
    const r = await fetch('https://realtime.oxylabs.io/v1/queries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(115000),
    });
    const j = await r.json();
    const res = j.results?.[0] || {};
    const c = res.content || '';
    console.log(`${label.padEnd(30)} | oxy ${r.status} | target ${res.status_code} | len ${c.length} | listing-item:${c.toLowerCase().includes('listing-item')}`);
    return c;
  } catch (e) {
    console.log(`${label.padEnd(30)} | ERR ${e.message}`);
    return '';
  }
}

(async () => {
  // 1) Sin render (sabemos que devuelve 200 + 1.25MB)
  const raw = await probe('1. maserati SIN render', { source: 'universal', url: listUrl, geo_location: 'Chile' });

  // Analizar el HTML crudo
  if (raw) {
    console.log('\n── ANÁLISIS HTML SIN RENDER ──');
    console.log('detalles links:', (raw.match(/\/vehiculos\/detalles\//g) || []).length);
    console.log('class="listing-item:', (raw.match(/class="[^"]*listing-item[^"]*"/gi) || []).length);
    // Buscar nombres de clase candidatos
    for (const kw of ['card', 'listing', 'vehicle', 'product', 'srp', 'result', 'tile', 'ad-']) {
      const re = new RegExp(`class="[^"]*${kw}[^"]*"`, 'gi');
      const m = raw.match(re) || [];
      const uniq = [...new Set(m.map(s => s.slice(0, 60)))].slice(0, 5);
      if (uniq.length) console.log(`  [${kw}] →`, uniq.join(' | '));
    }
    // Sample de hrefs con detalles
    const hrefs = [...new Set((raw.match(/href="([^"]*detalles[^"]*)"/gi) || []).map(s => s.slice(0, 90)))].slice(0, 5);
    console.log('sample detalles hrefs:', hrefs.length ? hrefs : '(ninguno)');
    // ¿App SPA? buscar marcadores
    console.log('tiene <app-root / ng-version / __NEXT_DATA__:', /app-root|ng-version|__NEXT_DATA__|window\.__/i.test(raw));
  }

  // 2) y 3) con render, dos intentos
  await probe('2. maserati render #1', { source: 'universal', url: listUrl, geo_location: 'Chile', render: 'html' });
  await probe('3. maserati render #2', { source: 'universal', url: listUrl, geo_location: 'Chile', render: 'html' });

  console.log('\n=== PROBE DONE ===');
})();
