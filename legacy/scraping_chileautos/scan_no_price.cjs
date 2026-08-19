const { DynamoDBClient, ScanCommand, UpdateTableCommand } = require('@aws-sdk/client-dynamodb');
const c = new DynamoDBClient({
    region: 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    },
    maxAttempts: 10
});

async function main() {
    console.log('Scanning for vehicles without price...');

    let lastKey;
    const brands = {};
    let total = 0;
    let noPriceTotal = 0;
    const noPriceUrls = [];
    let batch = 0;

    do {
        const res = await c.send(new ScanCommand({
            TableName: 'chileautos_vehiculos',
            ProjectionExpression: 'marca, modelo, ano, precio_clp, #u, vehiculo_id',
            ExpressionAttributeNames: { '#u': 'url' },
            ExclusiveStartKey: lastKey
        }));

        for (const item of (res.Items || [])) {
            total++;
            const marca = item.marca ? item.marca.S : '?';
            const precio = item.precio_clp ? (item.precio_clp.N || item.precio_clp.S) : '';

            if (!brands[marca]) brands[marca] = { total: 0, noPrice: 0 };
            brands[marca].total++;

            if (!precio || precio === '' || precio === '0') {
                brands[marca].noPrice++;
                noPriceTotal++;
                noPriceUrls.push({
                    url: item.url ? item.url.S : '',
                    id: item.vehiculo_id ? item.vehiculo_id.S : '',
                    marca,
                    modelo: item.modelo ? item.modelo.S : '?',
                    ano: item.ano ? item.ano.N : '?'
                });
            }
        }

        lastKey = res.LastEvaluatedKey;
        batch++;
        if (batch % 10 === 0) process.stderr.write(batch + ' ');
    } while (lastKey);

    console.log('');
    console.log('=== RESUMEN ===');
    console.log('Total items:', total.toLocaleString());
    console.log('Sin precio:', noPriceTotal.toLocaleString(), '(' + (noPriceTotal / total * 100).toFixed(1) + '%)');
    console.log('');

    // Show brands with no-price vehicles
    const sorted = Object.entries(brands)
        .filter(([_, d]) => d.noPrice > 0)
        .sort((a, b) => b[1].noPrice - a[1].noPrice);

    console.log('Marca|Total|SinPrecio|%');
    for (const [m, d] of sorted) {
        console.log(m + '|' + d.total + '|' + d.noPrice + '|' + (d.noPrice / d.total * 100).toFixed(1) + '%');
    }

    // Save no-price URLs to file
    const fs = require('fs');
    const urls = noPriceUrls.map(u => u.url).filter(u => u);
    fs.writeFileSync(__dirname + '/retry/no_price_urls.json', JSON.stringify(urls, null, 2));
    console.log('');
    console.log('Saved ' + urls.length + ' URLs to retry/no_price_urls.json');

    // Restore to provisioned
    console.log('Restoring billing to PROVISIONED 25/25...');
    try {
        await c.send(new UpdateTableCommand({
            TableName: 'chileautos_vehiculos',
            BillingMode: 'PROVISIONED',
            ProvisionedThroughput: { ReadCapacityUnits: 25, WriteCapacityUnits: 25 }
        }));
        console.log('Restored.');
    } catch (e) {
        console.log('Restore note:', e.message);
    }
}

main().catch(e => console.error(e));
