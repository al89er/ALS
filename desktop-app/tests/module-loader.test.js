process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const moduleLoader = require('../module-loader');
const moduleUpdater = require('../module-updater');
const trayManager = require('../tray-manager');

// Setup isolated temporary directory for test modules
const testTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'als-module-loader-test-'));
const testModulesDir = path.join(testTempDir, 'modules');
fs.mkdirSync(testModulesDir, { recursive: true });

// Initialize loader with test directories
moduleLoader.init({
  modulesDir: testModulesDir,
  baseDir: path.resolve(__dirname, '..')
});

test('Module Loader: Loads factory fallback when dynamic module does not exist', () => {
  moduleLoader.clearModuleCache();
  const fallback = { VERSION: '1.5.8', name: 'factory_fallback', ping: () => 'pong' };
  const loaded = moduleLoader.loadModule('non_existent_module', fallback);
  
  assert.strictEqual(loaded, fallback);
  assert.strictEqual(loaded.ping(), 'pong');
  
  const info = moduleLoader.getLoadedModuleInfo();
  assert.ok(info['non_existent_module']);
  assert.strictEqual(info['non_existent_module'].source, 'factory');
  assert.strictEqual(info['non_existent_module'].version, '1.5.8');
});

test('Module Loader: Loads valid dynamic module from disk when present', () => {
  moduleLoader.clearModuleCache();
  
  const dynamicCode = `
    const VERSION = '1.5.9-dynamic';
    function greet() { return 'Hello from dynamic module!'; }
    module.exports = { VERSION, greet };
  `;
  const dynamicFilePath = path.join(testModulesDir, 'sample_dynamic.js');
  fs.writeFileSync(dynamicFilePath, dynamicCode, 'utf8');

  const fallback = { VERSION: '1.5.8', greet: () => 'fallback' };
  const loaded = moduleLoader.loadModule('sample_dynamic', fallback);

  assert.notStrictEqual(loaded, fallback);
  assert.strictEqual(loaded.VERSION, '1.5.9-dynamic');
  assert.strictEqual(loaded.greet(), 'Hello from dynamic module!');

  const info = moduleLoader.getLoadedModuleInfo();
  assert.strictEqual(info['sample_dynamic'].source, 'dynamic');
  assert.strictEqual(info['sample_dynamic'].version, '1.5.9-dynamic');
});

test('Module Loader Fail-Safe: Recovers gracefully on syntax error and quarantines corrupted file', () => {
  moduleLoader.clearModuleCache();
  
  // Intentionally invalid JavaScript syntax
  const corruptedCode = `const broken = ;;; function ( { `;
  const brokenFilePath = path.join(testModulesDir, 'broken_syntax.js');
  fs.writeFileSync(brokenFilePath, corruptedCode, 'utf8');

  const fallback = { VERSION: '1.5.8', status: 'safe_factory' };
  const loaded = moduleLoader.loadModule('broken_syntax', fallback);

  // Must return the factory module
  assert.strictEqual(loaded, fallback);
  assert.strictEqual(loaded.status, 'safe_factory');

  // The corrupted file should have been moved/quarantined so future boots don't fail
  assert.strictEqual(fs.existsSync(brokenFilePath), false, 'Corrupted file must be removed or quarantined');
});

test('Module Loader Fail-Safe: Recovers gracefully when dynamic module throws runtime error during init', () => {
  moduleLoader.clearModuleCache();

  // Throws during evaluation
  const explodingCode = `throw new Error('Fatal error during module initialization');`;
  const explodingFilePath = path.join(testModulesDir, 'exploding_init.js');
  fs.writeFileSync(explodingFilePath, explodingCode, 'utf8');

  const fallback = { VERSION: '1.5.8', status: 'safe_factory_recovery' };
  const loaded = moduleLoader.loadModule('exploding_init', fallback);

  assert.strictEqual(loaded, fallback);
  assert.strictEqual(loaded.status, 'safe_factory_recovery');
});

test('Module Loader: UI Path Resolution resolves dynamic HTML when present and falls back when missing', () => {
  const fallbackUI = path.join(__dirname, '..', 'hub-ui.html');

  // 1. When dynamic UI doesn't exist, returns fallback
  const resolvedFallback = moduleLoader.resolveUIPath('custom-ui.html', fallbackUI);
  assert.strictEqual(resolvedFallback, fallbackUI);

  // 2. When dynamic UI exists (> 100 bytes), returns dynamic path
  const dynamicUIPath = path.join(testModulesDir, 'custom-ui.html');
  const dummyHtml = `<!DOCTYPE html><html><head><title>Dynamic UI</title></head><body><h1>Updated Interface</h1></body></html>`;
  fs.writeFileSync(dynamicUIPath, dummyHtml, 'utf8');

  const resolvedDynamic = moduleLoader.resolveUIPath('custom-ui.html', fallbackUI);
  assert.strictEqual(resolvedDynamic, dynamicUIPath);
});

test('Module Updater: Semver comparison correctly calculates upgrade necessity', () => {
  assert.strictEqual(moduleUpdater.compareSemver('1.5.9', '1.5.8'), 1);
  assert.strictEqual(moduleUpdater.compareSemver('1.5.8', '1.5.8'), 0);
  assert.strictEqual(moduleUpdater.compareSemver('1.5.7', '1.5.8'), -1);
  assert.strictEqual(moduleUpdater.compareSemver('v2.0.0', '1.9.9'), 1);
  assert.strictEqual(moduleUpdater.compareSemver('1.6.0', 'v1.5.8'), 1);
});

test('Module Updater: Cryptographic hash calculation matches expected SHA-256', () => {
  const content = 'Test module content for SHA-256 verification';
  const expectedHash = require('crypto').createHash('sha256').update(content).digest('hex');

  const computedHash = moduleUpdater.computeHash(content);
  assert.strictEqual(computedHash, expectedHash);
});

test('Module Updater: Atomic update installation verifies hash and AST validity', async () => {
  const validCode = `
    const VERSION = '1.6.0';
    function run() { return 'executed v1.6.0'; }
    module.exports = { VERSION, run };
  `;
  const codeHash = moduleUpdater.computeHash(Buffer.from(validCode, 'utf8'));

  // Mock global fetch to simulate downloading update
  const originalFetch = global.fetch;
  global.fetch = async (url) => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => Buffer.from(validCode, 'utf8')
  });

  const updateInfo = {
    file: 'atomic_test.js',
    targetVersion: '1.6.0',
    sha256: codeHash,
    requiresRelaunch: true
  };

  const installResult = await moduleUpdater.installModuleUpdate('atomic_test', updateInfo);
  assert.strictEqual(installResult.success, true);
  assert.strictEqual(installResult.version, '1.6.0');

  // Verify file was written to disk in modules dir
  const targetOnDisk = path.join(testModulesDir, 'atomic_test.js');
  assert.ok(fs.existsSync(targetOnDisk));
  assert.strictEqual(fs.readFileSync(targetOnDisk, 'utf8'), validCode);

  // Restore fetch
  global.fetch = originalFetch;
});

test('Module Updater: Rejects corrupted download when SHA-256 hash does not match', async () => {
  const tamperedCode = `console.log("tampered");`;
  const wrongExpectedHash = '0000000000000000000000000000000000000000000000000000000000000000';

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => Buffer.from(tamperedCode, 'utf8')
  });

  const updateInfo = {
    file: 'tampered_test.js',
    targetVersion: '1.6.0',
    sha256: wrongExpectedHash
  };

  const installResult = await moduleUpdater.installModuleUpdate('tampered_test', updateInfo);
  assert.strictEqual(installResult.success, false);
  assert.ok(installResult.error.includes('Integrity verification failed'));

  // Target file must NOT exist on disk
  const targetOnDisk = path.join(testModulesDir, 'tampered_test.js');
  assert.strictEqual(fs.existsSync(targetOnDisk), false);

  global.fetch = originalFetch;
});

test('Tray Manager: Formats tooltips correctly for Hub, Lite, and Full editions', () => {
  const cache = {
    daily_schedule: {
      date: new Date().toLocaleDateString('en-CA'),
      scheduled_clock_in: '07:48',
      scheduled_clock_out: '17:08',
      skipped: false
    },
    todays_proof: {
      date: new Date().toLocaleDateString('en-CA'),
      clock_in: '07:49:12',
      clock_out: '17:09:05'
    }
  };

  // 1. Hub edition format
  const hubTooltip = trayManager.formatTrayTooltip({
    edition: 'hub',
    connectivityState: 'Connected to Supabase',
    cache,
    accounts: [{ device_id: 'AMIR' }, { device_id: 'USER2' }]
  });
  assert.ok(hubTooltip.includes('[HUB'));
  assert.ok(hubTooltip.includes('Active Accounts: 2'));

  // 2. Full edition format
  const fullTooltip = trayManager.formatTrayTooltip({
    edition: 'full',
    connectivityState: 'Connected to Supabase',
    cache
  });
  assert.ok(fullTooltip.includes('[ALS'));
  assert.ok(fullTooltip.includes('Target In: 07:48'));
  assert.ok(fullTooltip.includes('Proof In: 07:49:12'));

  // 3. Lite edition format
  const liteTooltip = trayManager.formatTrayTooltip({
    edition: 'lite',
    connectivityState: 'Connected to Supabase',
    cache
  });
  assert.ok(liteTooltip.includes('[LITE'));
  assert.ok(liteTooltip.includes('Proof In: 07:49:12'));
});

test('Manifest Auto-Versioner: Increments semver and updates source files in-place', () => {
  const manifestUpdater = require('../update-manifest');

  // 1. Semver comparison
  assert.strictEqual(manifestUpdater.compareSemver('1.6.4', '1.5.8'), 1);
  assert.strictEqual(manifestUpdater.compareSemver('1.5.8', '1.6.4'), -1);
  assert.strictEqual(manifestUpdater.compareSemver('1.6.4', '1.6.4'), 0);

  // 2. Semver incrementing
  assert.strictEqual(manifestUpdater.incrementSemver('1.6.4', 'patch'), '1.6.5');
  assert.strictEqual(manifestUpdater.incrementSemver('1.6.4', 'minor'), '1.7.0');
  assert.strictEqual(manifestUpdater.incrementSemver('1.6.4', 'major'), '2.0.0');

  // 3. In-place JS file version updating
  const tempJsPath = path.join(testModulesDir, 'version_test.js');
  fs.writeFileSync(tempJsPath, "const VERSION = '1.6.4';\nmodule.exports = { VERSION };\n", 'utf8');
  manifestUpdater.updateVersionInFile(tempJsPath, '1.6.5');
  assert.strictEqual(manifestUpdater.extractVersionFromFile(tempJsPath), '1.6.5');

  // 4. In-place HTML file version updating
  const tempHtmlPath = path.join(testModulesDir, 'version_test.html');
  fs.writeFileSync(tempHtmlPath, "<!-- VERSION: 1.6.4 -->\n<div><span id=\"hubVersionBadge\">v1.6.4</span></div>\n", 'utf8');
  manifestUpdater.updateVersionInFile(tempHtmlPath, '1.6.5');
  assert.strictEqual(manifestUpdater.extractVersionFromFile(tempHtmlPath), '1.6.5');
  const updatedHtml = fs.readFileSync(tempHtmlPath, 'utf8');
  assert.ok(updatedHtml.includes('id="hubVersionBadge">v1.6.5</span>'));
});

