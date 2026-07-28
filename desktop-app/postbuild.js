const fs = require('fs');
const path = require('path');

// Build output is in C:\Temp\ALS-build (outside OneDrive to avoid EBUSY locks)
const buildDir = 'C:\\Temp\\ALS-build';
const version = require('./package.json').version || '1.4.0';
// Primary copy target: outside OneDrive (always safe)
const tempReleases = `C:\\Temp\\ALS-releases\\v${version}`;
// Also copy into the workspace releases/ and dist/ folders
const wsReleases = path.join(__dirname, 'releases', `v${version}`);
const distDir = path.join(__dirname, 'dist');

function safeCopy(src, destDir, label) {
  try {
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, path.basename(src));
    fs.copyFileSync(src, dest);
    const stat = fs.statSync(dest);
    console.log(`[POSTBUILD] ✅ Copied to ${label} (${(stat.size / 1024 / 1024).toFixed(1)} MB): ${dest}`);
    return true;
  } catch (err) {
    console.error(`[POSTBUILD] ❌ Failed to copy to ${label}: ${err.message}`);
    return false;
  }
}

console.log('[POSTBUILD] Checking build folder:', buildDir);
if (fs.existsSync(buildDir)) {
  const files = fs.readdirSync(buildDir);
  console.log('[POSTBUILD] Files found in build dir:', files);
  let found = false;
  for (const file of files) {
    if (file.endsWith('.exe') && !file.includes('uninstaller')) {
      const src = path.join(buildDir, file);
      // 1. Copy to C:\Temp\ALS-releases\ (safe, outside OneDrive)
      safeCopy(src, tempReleases, 'C:\\Temp\\ALS-releases');
      // 2. Copy to workspace releases/
      safeCopy(src, wsReleases, `releases/v${version}`);
      // 3. Copy to dist/
      safeCopy(src, distDir, 'dist');
      found = true;
    }
  }
  if (!found) console.log('[POSTBUILD] No .exe setup files found.');
} else {
  console.log('[POSTBUILD] Build dir not found:', buildDir);
}
