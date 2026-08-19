const fs = require('fs');
const path = require('path');

// Read all failed URLs
const urls = fs.readFileSync(path.join(__dirname, 'retry', 'all_failed.txt'), 'utf-8')
    .split('\n')
    .map(u => u.trim())
    .filter(u => u.length > 0);

console.log(`Total unique failed URLs: ${urls.length}`);

// Shuffle to distribute brands evenly
for (let i = urls.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [urls[i], urls[j]] = [urls[j], urls[i]];
}

// Split into 6 chunks
const VPS_COUNT = 6;
const chunkSize = Math.ceil(urls.length / VPS_COUNT);

for (let i = 0; i < VPS_COUNT; i++) {
    const chunk = urls.slice(i * chunkSize, (i + 1) * chunkSize);
    const outFile = path.join(__dirname, 'retry', `retry_vps_${i + 1}.json`);
    fs.writeFileSync(outFile, JSON.stringify(chunk, null, 2));
    console.log(`VPS ${i + 1}: ${chunk.length} URLs → ${outFile}`);
}
