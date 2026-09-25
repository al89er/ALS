#!/usr/bin/env node
/**
 * ALS Manifest Generator & Integrity Validator
 * Updates desktop-app/modules-manifest.json with real-time SHA-256 hashes, file sizes, and versions.
 * 
 * Features:
 * - Syntax AST validation via vm.Script
 * - Auto-detects modified code (hash diff vs manifest)
 * - Auto-increments module VERSION if code changed without version bump
 * - Automatically writes bumped version directly back into source file
 * - Keeps package.json in sync with highest module version
 * 
 * Usage:
 *   node update-manifest.js                 # Auto-detects changes and auto-bumps modified modules
 *   node update-manifest.js 1.6.5           # Explicitly sets manifest version
 *   node update-manifest.js --bump minor    # Bumps minor version on modified modules
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');

const baseDir = __dirname;
const manifestPath = path.join(baseDir, 'modules-manifest.json');
const packageJsonPath = path.join(baseDir, 'package.json');

const targetModules = [
  { name: 'automation', file: 'automation.js', type: 'engine', description: 'Playwright automation engine, multi-device clocking, and proof capture' },
  { name: 'hub-client', file: 'hub-client.js', type: 'engine', description: 'Multi-account hub orchestrator, heartbeat recovery, and atomic queue' },
  { name: 'scheduler', file: 'scheduler.js', type: 'engine', description: 'Daily schedule generator, node-cron triggers, and missed action recovery' },
  { name: 'supabase-client', file: 'supabase-client.js', type: 'network', description: 'Supabase client, realtime WebSocket listener, and offline queue reconciler' },
  { name: 'cache-manager', file: 'cache-manager.js', type: 'storage', description: 'Local JSON cache, settings persistence, and hub accounts manager' },
  { name: 'tray-manager', file: 'tray-manager.js', type: 'ui', description: 'Modular Windows system tray tooltip and context menu formatter' },
  { name: 'hub-ui', file: 'hub-ui.html', type: 'ui', description: 'ALS Server Hub administrative UI' },
  { name: 'desktop-ui', file: 'desktop-ui.html', type: 'ui', description: 'ALS Single Agent desktop interface' }
];

function compareSemver(v1, v2) {
  const p1 = (v1 || '0').replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const p2 = (v2 || '0').replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
    const num1 = p1[i] || 0;
    const num2 = p2[i] || 0;
    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }
  return 0;
}

function incrementSemver(version, type = 'patch') {
  const clean = (version || '1.5.8').replace(/^v/, '');
  const parts = clean.split('.').map(n => parseInt(n, 10) || 0);
  while (parts.length < 3) parts.push(0);
  if (type === 'major') {
    parts[0]++;
    parts[1] = 0;
    parts[2] = 0;
  } else if (type === 'minor') {
    parts[1]++;
    parts[2] = 0;
  } else {
    parts[2]++;
  }
  return parts.join('.');
}

function extractVersionFromFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const match = content.match(/(?:VERSION\s*=\s*['"]|<!--\s*VERSION:\s*)([^'"\s>]+)/);
    if (match) return match[1];
  } catch (e) {}
  return '1.5.8';
}

function updateVersionInFile(filePath, newVersion) {
  let content = fs.readFileSync(filePath, 'utf8');
  if (filePath.endsWith('.js')) {
    content = content.replace(/(const\s+VERSION\s*=\s*['"])[^'"]+(['"];?)/, `$1${newVersion}$2`);
  } else if (filePath.endsWith('.html')) {
    content = content.replace(/(<!--\s*VERSION:\s*)[^\s>]+(\s*-->)/, `$1${newVersion}$2`);
    content = content.replace(/(id="hubVersionBadge">v)[^<]+(<\/span>)/, `$1${newVersion}$2`);
  }
  fs.writeFileSync(filePath, content, 'utf8');
}

function updateManifest(customArg) {
  let existingManifest = {};
  if (fs.existsSync(manifestPath)) {
    try {
      existingManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (e) {}
  }

  const existingModules = existingManifest.modules || {};
  let bumpType = 'patch';
  let explicitVersion = null;

  if (customArg) {
    if (customArg.startsWith('--bump=')) {
      bumpType = customArg.split('=')[1] || 'patch';
    } else if (customArg === '--bump' || customArg === '-b') {
      bumpType = 'patch';
    } else if (/^\d+\.\d+\.\d+/.test(customArg)) {
      explicitVersion = customArg;
    }
  }

  console.log(`\n======================================================`);
  console.log(`  ALS Modular Manifest Generator & Auto-Versioner`);
  console.log(`======================================================\n`);

  const updatedModules = {};
  let highestVersion = explicitVersion || existingManifest.version || '1.5.8';
  let autoBumpsCount = 0;

  for (const target of targetModules) {
    const fullPath = path.join(baseDir, target.file);
    if (!fs.existsSync(fullPath)) {
      console.error(`[ERROR] Target file missing: ${target.file}`);
      process.exit(1);
    }

    let contentBuffer = fs.readFileSync(fullPath);
    let sha256 = crypto.createHash('sha256').update(contentBuffer).digest('hex');
    let fileVersion = extractVersionFromFile(fullPath);

    // Check if code changed compared to the recorded manifest hash
    const prevMod = existingModules[target.name];
    if (prevMod && prevMod.sha256 && prevMod.sha256 !== sha256) {
      // Code was modified! Check if version was bumped
      if (compareSemver(fileVersion, prevMod.version) <= 0) {
        const nextVersion = incrementSemver(prevMod.version || fileVersion, bumpType);
        console.log(`⚡ [AUTO-BUMP] Detected code changes in ${target.file} without version bump.`);
        console.log(`   Auto-incrementing ${fileVersion} -> ${nextVersion} in file and manifest...`);
        
        updateVersionInFile(fullPath, nextVersion);
        fileVersion = nextVersion;
        autoBumpsCount++;

        // Re-read updated file buffer and recompute hash
        contentBuffer = fs.readFileSync(fullPath);
        sha256 = crypto.createHash('sha256').update(contentBuffer).digest('hex');
      }
    }

    const sizeBytes = contentBuffer.length;

    // Syntax validation for JS
    if (target.file.endsWith('.js')) {
      const code = contentBuffer.toString('utf8');
      try {
        new vm.Script(`(function(){ ${code}\n})`, { filename: target.file });
      } catch (syntaxErr) {
        console.error(`[SYNTAX ERROR] Failed to validate AST for ${target.file}: ${syntaxErr.message}`);
        process.exit(1);
      }
    }

    if (compareSemver(fileVersion, highestVersion) > 0) {
      highestVersion = fileVersion;
    }

    updatedModules[target.name] = {
      file: target.file,
      version: fileVersion,
      type: target.type,
      sizeBytes: sizeBytes,
      sha256: sha256,
      description: target.description
    };

    console.log(`✓ ${target.file.padEnd(20)} [v${fileVersion}]  ${(sizeBytes / 1024).toFixed(1).padStart(6)} KB  SHA: ${sha256.substring(0, 16)}...`);
  }

  const manifestVersion = explicitVersion || highestVersion;

  const outputManifest = {
    version: manifestVersion,
    name: 'ALS Modular Engine',
    updatedAt: new Date().toISOString(),
    modules: updatedModules
  };

  fs.writeFileSync(manifestPath, JSON.stringify(outputManifest, null, 2), 'utf8');
  console.log(`\n[SUCCESS] Updated manifest (v${manifestVersion}) written to: ${manifestPath}`);
  if (autoBumpsCount > 0) {
    console.log(`[INFO] Auto-bumped ${autoBumpsCount} module(s) due to detected code edits.\n`);
  }

  // Keep package.json version synchronized
  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      if (compareSemver(manifestVersion, pkg.version) > 0) {
        pkg.version = manifestVersion;
        fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
        console.log(`[SYNC] Updated package.json version to v${manifestVersion}`);
      }
    } catch (e) {}
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const cliArg = args[0];
  updateManifest(cliArg);
}

module.exports = {
  compareSemver,
  incrementSemver,
  extractVersionFromFile,
  updateVersionInFile,
  updateManifest
};

