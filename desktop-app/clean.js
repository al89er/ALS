const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, 'dist');

// Stop running unpacked instances to release file locks on dist/win-unpacked
try {
  if (process.platform === 'win32') {
    execSync('taskkill /F /IM "ALS Automation Engine.exe" /T', { stdio: 'ignore' });
    execSync('taskkill /F /IM "electron.exe" /T', { stdio: 'ignore' });
  }
} catch (e) {}

function cleanUnpacked(retries = 8, delay = 1500) {
  if (!fs.existsSync(distDir)) return;
  
  const winUnpacked = path.join(distDir, 'win-unpacked');
  for (let i = 0; i < retries; i++) {
    try {
      if (fs.existsSync(winUnpacked)) {
        fs.rmSync(winUnpacked, { recursive: true, force: true });
      }
      // Remove temporary .blockmap or .7z files but KEEP .exe setups
      const files = fs.readdirSync(distDir);
      for (const file of files) {
        if (file.endsWith('.blockmap') || file.endsWith('.7z') || file.includes('__uninstaller')) {
          fs.rmSync(path.join(distDir, file), { force: true });
        }
      }
      console.log('[BUILD] Successfully prepared dist directory.');
      return;
    } catch (err) {
      if (i === retries - 1) {
        console.warn('[BUILD] Warning during clean:', err.message);
      } else {
        const end = Date.now() + delay;
        while (Date.now() < end) {}
      }
    }
  }
}

cleanUnpacked();
