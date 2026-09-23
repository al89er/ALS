// Module Updater - Secure manifest checker, downloader, and atomic installer
// Allows lightweight dynamic updates for ALS Single Agent and Hub editions.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const moduleLoader = require('./module-loader');

const DEFAULT_MANIFEST_URL = 'https://raw.githubusercontent.com/al89er/ALS/main/desktop-app/modules-manifest.json';
const BRANCH_MANIFEST_URL = 'https://raw.githubusercontent.com/al89er/ALS/feat/clock-actions-proof-confirmation/desktop-app/modules-manifest.json';

let customManifestUrl = null;

/**
 * Configure updater options.
 * @param {Object} options
 * @param {string} [options.manifestUrl]
 */
function init(options = {}) {
  if (options.manifestUrl) {
    customManifestUrl = options.manifestUrl;
  }
}

/**
 * Gets the manifest URL to check for updates.
 */
function getManifestUrl() {
  return customManifestUrl || process.env.ALS_UPDATE_MANIFEST_URL || DEFAULT_MANIFEST_URL;
}

/**
 * Computes SHA-256 checksum for a string or buffer.
 * @param {string|Buffer} data
 * @returns {string} Hex hash
 */
function computeHash(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Computes SHA-256 checksum of a file on disk.
 * @param {string} filePath
 * @returns {string|null} Hex hash or null if file doesn't exist
 */
function computeFileHash(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath);
    return computeHash(content);
  } catch (err) {
    return null;
  }
}

/**
 * Compares two semantic version strings (e.g., '1.5.8' and '1.5.9').
 * @param {string} v1
 * @param {string} v2
 * @returns {number} 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 */
function compareSemver(v1, v2) {
  if (!v1 && !v2) return 0;
  if (!v1) return -1;
  if (!v2) return 1;

  // Clean prefixes like 'v'
  const clean1 = String(v1).replace(/^v/i, '').trim();
  const clean2 = String(v2).replace(/^v/i, '').trim();

  const parts1 = clean1.split('.').map(p => parseInt(p, 10) || 0);
  const parts2 = clean2.split('.').map(p => parseInt(p, 10) || 0);

  const maxLen = Math.max(parts1.length, parts2.length);
  for (let i = 0; i < maxLen; i++) {
    const num1 = parts1[i] || 0;
    const num2 = parts2[i] || 0;
    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }
  return 0;
}

/**
 * Reads local installed-manifest.json in modules directory.
 */
function getInstalledManifest() {
  const modulesDir = moduleLoader.getModulesDir();
  const manifestPath = path.join(modulesDir, 'installed-manifest.json');
  try {
    if (fs.existsSync(manifestPath)) {
      return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    }
  } catch (e) {}
  return { version: '1.0.0', modules: {} };
}

/**
 * Reads base bundled modules-manifest.json packaged with the application.
 */
function getBundledManifest() {
  const bundledPath = path.join(__dirname, 'modules-manifest.json');
  try {
    if (fs.existsSync(bundledPath)) {
      return JSON.parse(fs.readFileSync(bundledPath, 'utf8'));
    }
  } catch (e) {}
  return { version: '1.5.8', modules: {} };
}

/**
 * Saves updated installed-manifest.json to modules directory.
 */
function saveInstalledManifest(manifest) {
  const modulesDir = moduleLoader.getModulesDir();
  moduleLoader.ensureModulesDir();
  const manifestPath = path.join(modulesDir, 'installed-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
}

/**
 * Checks remote repository for available module updates.
 * @param {string} [overrideUrl]
 * @returns {Promise<Object>} Update summary
 */
async function checkForUpdates(overrideUrl) {
  let url = overrideUrl || getManifestUrl();
  console.log(`[MODULE-UPDATER] Checking for module updates from: ${url}`);

  let remoteManifest;
  let activeManifestUrl = url;
  try {
    let response = await fetch(url, {
      headers: { 'Cache-Control': 'no-cache' }
    });
    if (response.status === 404 && url === DEFAULT_MANIFEST_URL && BRANCH_MANIFEST_URL) {
      console.log(`[MODULE-UPDATER] main branch manifest 404, falling back to branch: ${BRANCH_MANIFEST_URL}`);
      url = BRANCH_MANIFEST_URL;
      activeManifestUrl = url;
      response = await fetch(url, {
        headers: { 'Cache-Control': 'no-cache' }
      });
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    remoteManifest = await response.json();
  } catch (err) {
    console.warn('[MODULE-UPDATER] Failed to check for updates:', err.message);
    return {
      success: false,
      error: err.message,
      hasUpdates: false,
      availableUpdates: []
    };
  }

  const bundledManifest = getBundledManifest();
  const installedManifest = getInstalledManifest();
  const modulesDir = moduleLoader.getModulesDir();
  const availableUpdates = [];

  const remoteModules = remoteManifest.modules || {};
  for (const [modName, modInfo] of Object.entries(remoteModules)) {
    const targetFile = modInfo.file || `${modName}.js`;
    const localDynamicPath = path.join(modulesDir, targetFile);
    const localBundledPath = path.join(__dirname, targetFile);

    let currentVersion = 'factory';
    let currentHash = null;

    if (installedManifest.modules && installedManifest.modules[modName]) {
      currentVersion = installedManifest.modules[modName].version;
      currentHash = installedManifest.modules[modName].sha256;
    } else if (bundledManifest.modules && bundledManifest.modules[modName]) {
      currentVersion = bundledManifest.modules[modName].version;
      currentHash = bundledManifest.modules[modName].sha256;
    }

    if (fs.existsSync(localDynamicPath)) {
      currentHash = computeFileHash(localDynamicPath);
    } else if (fs.existsSync(localBundledPath)) {
      currentHash = computeFileHash(localBundledPath);
    }

    const isVersionNewer = compareSemver(modInfo.version, currentVersion) > 0;
    const isHashDifferent = modInfo.sha256 && currentHash && modInfo.sha256 !== currentHash;

    if (isVersionNewer || (isHashDifferent && !isVersionNewer && modInfo.forceUpdate)) {
      availableUpdates.push({
        name: modName,
        file: targetFile,
        currentVersion: currentVersion,
        targetVersion: modInfo.version,
        sha256: modInfo.sha256,
        sizeBytes: modInfo.sizeBytes || null,
        description: modInfo.description || '',
        downloadUrl: modInfo.downloadUrl || null,
        manifestBaseUrl: activeManifestUrl,
        requiresRelaunch: modInfo.type !== 'ui'
      });
    }
  }

  return {
    success: true,
    hasUpdates: availableUpdates.length > 0,
    remoteManifestVersion: remoteManifest.version,
    availableUpdates: availableUpdates,
    remoteManifest: remoteManifest
  };
}

/**
 * Downloads and installs a single module update atomically with hash and syntax verification.
 * @param {string} moduleName
 * @param {Object} updateInfo
 * @param {string} [manifestBaseUrl]
 * @returns {Promise<Object>} Installation result
 */
async function installModuleUpdate(moduleName, updateInfo, manifestBaseUrl) {
  const modulesDir = moduleLoader.getModulesDir();
  moduleLoader.ensureModulesDir();

  const fileName = updateInfo.file || `${moduleName}.js`;
  const targetPath = path.join(modulesDir, fileName);
  const tempPath = path.join(modulesDir, `${fileName}.tmp-${Date.now()}`);

  let downloadUrl = updateInfo.downloadUrl;
  if (!downloadUrl) {
    const baseUrl = updateInfo.manifestBaseUrl || manifestBaseUrl || getManifestUrl();
    const lastSlash = baseUrl.lastIndexOf('/');
    downloadUrl = baseUrl.substring(0, lastSlash + 1) + fileName;
  }

  console.log(`[MODULE-UPDATER] Downloading ${moduleName} from ${downloadUrl}...`);

  try {
    const res = await fetch(downloadUrl, {
      headers: { 'Cache-Control': 'no-cache' }
    });
    if (!res.ok) {
      throw new Error(`Failed to download ${fileName}: HTTP ${res.status}`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());

    // 1. Verify SHA-256 Integrity
    if (updateInfo.sha256) {
      const computed = computeHash(buffer);
      if (computed !== updateInfo.sha256) {
        throw new Error(`Integrity verification failed for ${moduleName}! Expected ${updateInfo.sha256}, got ${computed}`);
      }
    }

    // 2. Syntax Validation (for JavaScript files)
    if (fileName.endsWith('.js')) {
      const code = buffer.toString('utf8');
      try {
        new vm.Script(`(function(){ ${code}\n})`, { filename: fileName });
      } catch (syntaxErr) {
        throw new Error(`Syntax validation failed for ${fileName}: ${syntaxErr.message}`);
      }
    }

    // 3. Write to temporary file
    fs.writeFileSync(tempPath, buffer);

    // 4. Atomic swap: rename temp file to target destination
    fs.renameSync(tempPath, targetPath);

    // 5. Update local installed-manifest.json
    const installed = getInstalledManifest();
    installed.modules = installed.modules || {};
    installed.modules[moduleName] = {
      version: updateInfo.targetVersion || updateInfo.version,
      file: fileName,
      sha256: updateInfo.sha256 || computeHash(buffer),
      installedAt: new Date().toISOString()
    };
    saveInstalledManifest(installed);

    // 6. Invalidate module loader cache
    moduleLoader.clearModuleCache(moduleName);

    console.log(`[MODULE-UPDATER] Successfully installed dynamic update for ${moduleName} (v${updateInfo.targetVersion})`);
    return {
      success: true,
      module: moduleName,
      version: updateInfo.targetVersion,
      requiresRelaunch: updateInfo.requiresRelaunch !== false
    };
  } catch (err) {
    // Clean up temp file on failure
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch (_) {}
    console.error(`[MODULE-UPDATER] Failed to install update for ${moduleName}:`, err.message);
    return {
      success: false,
      module: moduleName,
      error: err.message
    };
  }
}

/**
 * Installs all available updates.
 * @param {Array} updatesList
 * @param {string} [manifestBaseUrl]
 */
async function installAllUpdates(updatesList, manifestBaseUrl) {
  const results = [];
  let anyRequiresRelaunch = false;

  for (const update of updatesList) {
    const res = await installModuleUpdate(update.name, update, manifestBaseUrl);
    results.push(res);
    if (res.success && res.requiresRelaunch) {
      anyRequiresRelaunch = true;
    }
  }

  const allSuccess = results.every(r => r.success);
  return {
    success: allSuccess,
    results: results,
    requiresRelaunch: anyRequiresRelaunch
  };
}

/**
 * Safely relaunches the Electron application.
 */
function relaunchApp() {
  try {
    const { app } = require('electron');
    if (app && typeof app.relaunch === 'function') {
      app.relaunch();
      app.exit(0);
      return true;
    }
  } catch (e) {}
  return false;
}

module.exports = {
  init,
  getManifestUrl,
  computeHash,
  computeFileHash,
  compareSemver,
  getInstalledManifest,
  getBundledManifest,
  checkForUpdates,
  installModuleUpdate,
  installAllUpdates,
  relaunchApp,
  __test: {
    saveInstalledManifest
  }
};
