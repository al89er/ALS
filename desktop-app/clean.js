const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Build happens in C:\Temp\ALS-build (outside OneDrive to avoid EBUSY locks from sync)
const buildDir = 'C:\\Temp\\ALS-build';
const distDir = path.join(__dirname, 'dist');

// Kill any running instances
try {
  if (process.platform === 'win32') {
    execSync('taskkill /F /IM "ALS Automation Engine.exe" /T', { stdio: 'ignore' });
    execSync('taskkill /F /IM "electron.exe" /T', { stdio: 'ignore' });
  }
} catch (e) {}

function cleanDir(dir, label) {
  if (!fs.existsSync(dir)) return;
  const retries = 5;
  const delay = 1000;
  for (let i = 0; i < retries; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`[BUILD] Cleaned ${label}.`);
      return;
    } catch (err) {
      if (i === retries - 1) {
        console.warn(`[BUILD] Warning: could not clean ${label}: ${err.message}`);
      } else {
        const end = Date.now() + delay;
        while (Date.now() < end) {}
      }
    }
  }
}

// Clean the temp build dir and recreate it
cleanDir(buildDir, 'C:\\Temp\\ALS-build');
fs.mkdirSync(buildDir, { recursive: true });

// Also clean old .exe files from dist (keep folder itself)
if (fs.existsSync(distDir)) {
  for (const file of fs.readdirSync(distDir)) {
    if (file.endsWith('.exe') || file.endsWith('.7z') || file.endsWith('.blockmap') || file.includes('__uninstaller')) {
      try { fs.rmSync(path.join(distDir, file), { force: true }); } catch {}
    }
  }
}

console.log('[BUILD] Successfully prepared build directory.');
