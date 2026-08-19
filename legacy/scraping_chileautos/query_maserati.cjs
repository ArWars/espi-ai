const { Firestore } = require('@google-cloud/firestore');

process.env.GOOGLE_APPLICATION_CREDENTIALS = '../scraper-sa-key.json';

const db = new Firestore({ projectId: 'espi-ia-491115' });

db.collection('chileautos_vehiculos')
  .where('marca', '==', 'maserati')
  .get()
  .then(snap => {
    console.log('\n🏎️  MASERATI en Firestore:', snap.size, 'unidades\n');

    const modelos = {};
    snap.docs.forEach(d => {
      const v = d.data();
      const m = v.modelo || 'Sin modelo';
      if (!modelos[m]) modelos[m] = [];
      modelos[m].push(v);
    });

    const entries = Object.entries(modelos).sort((a, b) => b[1].length - a[1].length);

    entries.forEach(([modelo, autos]) => {
      console.log('── ' + modelo + ' (' + autos.length + ' unidades)');
      autos.sort((a, b) => (b.ano || 0) - (a.ano || 0)).forEach(v => {
        const precio = v.precio_clp ? '$' + Number(v.precio_clp).toLocaleString('es-CL') : 'sin precio';
        const km = v.kilometraje || '-';
        const region = v.region || '-';
        const year = v.ano || '?';
        const dist = v.distintivo || '';
        console.log('   ' + year + ' | ' + dist + ' | ' + precio + ' | ' + km + ' | ' + region);
      });
      console.log('');
    });
    process.exit(0);
  })
  .catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
