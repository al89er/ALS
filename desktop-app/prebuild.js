const fs = require('fs');
const path = require('path');

const edition = process.argv[2]; // 'full' or 'lite'
const bundledEnvPath = path.join(__dirname, 'bundled.env');

if (fs.existsSync(bundledEnvPath)) {
    fs.unlinkSync(bundledEnvPath);
}

if (edition === 'full') {
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
        fs.copyFileSync(envPath, bundledEnvPath);
        console.log('[PREBUILD] Copied .env to bundled.env for Full edition.');
    } else {
        console.warn('[PREBUILD] WARNING: .env file not found!');
    }
} else {
    console.log('[PREBUILD] Lite edition: skipped bundling .env.');
}
