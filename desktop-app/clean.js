const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, 'dist');

function cleanDist(retries = 5, delay = 1000) {
  if (!fs.existsSync(distDir)) return;
  for (let i = 0; i < retries; i++) {
    try {
      fs.rmSync(distDir, { recursive: true, force: true });
      console.log('[BUILD] Successfully cleaned dist directory.');
      return;
    } catch (err) {
      if (i === retries - 1) {
        console.warn('[BUILD] Warning: Failed to clean dist completely:', err.message);
      } else {
        // Sleep synchronously for file locks to release
        const end = Date.now() + delay;
        while (Date.now() < end) {}
      }
    }
  }
}

cleanDist();
