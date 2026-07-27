const fs = require('fs');
const path = require('path');

// Build output is in C:\Temp\ALS-build (outside OneDrive to avoid EBUSY locks)
const buildDir = 'C:\\Temp\\ALS-build';
const version = require('./package.json').version || '1.4.0';
const releases = path.join(__dirname, 'releases', `v${version}`);
// Also copy into dist for convenience
const distDir = path.join(__dirname, 'dist');

console.log('[POSTBUILD] Checking build folder:', buildDir);
if (fs.existsSync(buildDir)) {
  const files = fs.readdirSync(buildDir);
  console.log('[POSTBUILD] Files found in build dir:', files);
  let found = false;
  for (const file of files) {
    if (file.endsWith('.exe') && !file.includes('uninstaller')) {
      // Copy to releases/
      if (!fs.existsSync(releases)) fs.mkdirSync(releases, { recursive: true });
      fs.copyFileSync(path.join(buildDir, file), path.join(releases, file));
      console.log(`[POSTBUILD] Successfully preserved ${file} in releases/v${version}/`);
      // Copy to dist/ for quick access
      if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });
      fs.copyFileSync(path.join(buildDir, file), path.join(distDir, file));
      console.log(`[POSTBUILD] Also copied ${file} to dist/`);
      found = true;
    }
  }
  if (!found) console.log('[POSTBUILD] No .exe setup files found.');
} else {
  console.log('[POSTBUILD] Build dir not found:', buildDir);
}
