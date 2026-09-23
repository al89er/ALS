#!/usr/bin/env node
/**
 * ALS Manifest Generator & Integrity Validator
 * Updates desktop-app/modules-manifest.json with real-time SHA-256 hashes, file sizes, and versions.
 * Usage: node update-manifest.js [optional-overall-manifest-version]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');

const baseDir = __dirname;
const manifestPath = path.join(baseDir, 'modules-manifest.json');

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

function extractVersionFromFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const match = content.match(/(?:VERSION\s*=\s*['"]|<!--\s*VERSION:\s*)([^'"\s>]+)/);
    if (match) return match[1];
  } catch (e) {}
  return '1.5.8';
}

function updateManifest(customVersion) {
  let existingManifest = {};
  if (fs.existsSync(manifestPath)) {
    try {
      existingManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (e) {}
  }

  const manifestVersion = customVersion || existingManifest.version || '1.5.8';
  const updatedModules = {};

  console.log(`\n======================================================`);
  console.log(`  ALS Modular Manifest Generator (v${manifestVersion})`);
  console.log(`======================================================\n`);

  for (const target of targetModules) {
    const fullPath = path.join(baseDir, target.file);
    if (!fs.existsSync(fullPath)) {
      console.error(`[ERROR] Target file missing: ${target.file}`);
      process.exit(1);
    }

    const contentBuffer = fs.readFileSync(fullPath);
    const sha256 = crypto.createHash('sha256').update(contentBuffer).digest('hex');
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

    const fileVersion = extractVersionFromFile(fullPath);

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

  const outputManifest = {
    version: manifestVersion,
    name: 'ALS Modular Engine',
    updatedAt: new Date().toISOString(),
    modules: updatedModules
  };

  fs.writeFileSync(manifestPath, JSON.stringify(outputManifest, null, 2), 'utf8');
  console.log(`\n[SUCCESS] Updated manifest written to: ${manifestPath}\n`);
}

const args = process.argv.slice(2);
const cliVersion = args[0];
updateManifest(cliVersion);
