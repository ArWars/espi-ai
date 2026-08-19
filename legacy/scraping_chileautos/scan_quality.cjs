const { DynamoDBClient, UpdateTableCommand, ScanCommand } = require('@aws-sdk/client-dynamodb');
const c = new DynamoDBClient({
    region: 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    },
    maxAttempts: 10
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
    // Already on PAY_PER_REQUEST from previous run
    console.log('Starting scan (PAY_PER_REQUEST mode)...');

    let lastKey;
    const brands = {};
    let batch = 0;
    let total = 0;
    const F = ['precio_clp', 'ano', 'kilometraje', 'combustible', 'transmision', 'region'];

    console.log('Scanning...');
    do {
        try {
            const res = await c.send(new ScanCommand({
                TableName: 'chileautos_vehiculos',
                ProjectionExpression: 'marca,precio_clp,ano,kilometraje,combustible,transmision,#r,datos_incompletos',
                ExpressionAttributeNames: { '#r': 'region' },
                ExclusiveStartKey: lastKey
            }));
            for (const item of (res.Items || [])) {
                total++;
                const m = item.marca ? item.marca.S : '?';
                if (!brands[m]) {
                    brands[m] = { t: 0, i: 0 };
                    for (const f of F) brands[m][f] = 0;
                }
                brands[m].t++;
                if (item.datos_incompletos && item.datos_incompletos.BOOL) brands[m].i++;
                for (const f of F) {
                    const v = (item[f] && (item[f].S || item[f].N)) || '';
                    if (v === '' || v === '0') brands[m][f]++;
                }
            }
            lastKey = res.LastEvaluatedKey;
            batch++;
            if (batch % 10 === 0) console.log('  batch', batch, '- total', total);
        } catch (e) {
            if (e.name === 'ProvisionedThroughputExceededException') {
                console.log('  throttled, waiting...');
                await sleep(3000);
                continue;
            }
            throw e;
        }
    } while (lastKey);

    console.log('Scan done:', total, 'items');
    console.log('');

    // Restore provisioned
    console.log('Restoring PROVISIONED 25/25...');
    try {
        await c.send(new UpdateTableCommand({
            TableName: 'chileautos_vehiculos',
            BillingMode: 'PROVISIONED',
            ProvisionedThroughput: { ReadCapacityUnits: 25, WriteCapacityUnits: 25 }
        }));
    } catch (e) {
        console.log('Restore note:', e.message);
    }

    const sorted = Object.entries(brands).sort((a, b) => b[1].t - a[1].t);
    let gt = 0, gi = 0, gp = 0, ga = 0, gk = 0;
    console.log('');
    console.log('Marca|Total|Incompleto|SinPrecio|SinAno|SinKm|SinComb|SinRegion');
    for (const [m, d] of sorted) {
        if (d.t < 3) continue;
        gt += d.t;
        gi += d.i;
        gp += d.precio_clp;
        ga += d.ano;
        gk += d.kilometraje;
        console.log([m, d.t, d.i, d.precio_clp, d.ano, d.kilometraje, d.combustible, d.region].join('|'));
    }
    console.log('');
    console.log('TOTAL|' + gt + '|' + gi + '|' + gp + '|' + ga + '|' + gk);
}

main().catch(e => console.error(e));
