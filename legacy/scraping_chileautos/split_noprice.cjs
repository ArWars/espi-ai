const fs = require('fs');
const path = require('path');

const urls = JSON.parse(fs.readFileSync(path.join(__dirname, 'retry', 'no_price_urls.json'), 'utf-8'));
console.log('Total no-price URLs:', urls.length);

// Shuffle
for (let i = urls.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [urls[i], urls[j]] = [urls[j], urls[i]];
}

const VPS_COUNT = 6;
const chunkSize = Math.ceil(urls.length / VPS_COUNT);
for (let i = 0; i < VPS_COUNT; i++) {
    const chunk = urls.slice(i * chunkSize, (i + 1) * chunkSize);
    const outFile = path.join(__dirname, 'retry', `noprice_vps_${i + 1}.json`);
    fs.writeFileSync(outFile, JSON.stringify(chunk, null, 2));
    console.log(`VPS ${i + 1}: ${chunk.length} URLs`);
}
