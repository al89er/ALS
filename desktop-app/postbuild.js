const fs = require('fs');
const path = require('path');

const dist = path.join(__dirname, 'dist');
const version = require('./package.json').version || '1.3.0';
const releases = path.join(__dirname, 'releases', `v${version}`);

console.log('[POSTBUILD] Checking dist folder:', dist);
if (fs.existsSync(dist)) {
  const files = fs.readdirSync(dist);
  console.log('[POSTBUILD] Files found in dist:', files);
  let found = false;
  for (const file of files) {
    if (file.endsWith('.exe') && !file.includes('uninstaller')) {
      if (!fs.existsSync(releases)) fs.mkdirSync(releases, { recursive: true });
      fs.copyFileSync(path.join(dist, file), path.join(releases, file));
      console.log(`[POSTBUILD] Successfully preserved ${file} in releases/v${version}/`);
      found = true;
    }
  }
  if (!found) console.log('[POSTBUILD] No .exe setup files found in dist.');
}
