const fs = require('fs');
const path = require('path');
const {
  DEFAULT_SUPABASE_URL,
  resolveSupabasePublishableKey,
  isSupabasePublishableKey
} = require('./supabase-config');

function resolveCacheFile() {
  if (process.env.ALS_CACHE_FILE) {
    return path.resolve(process.env.ALS_CACHE_FILE);
  }

  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'), 'local_cache.json');
    }
  } catch (error) {
    // Fall through to development path.
  }

  return path.join(__dirname, 'local_cache.json');
}

const CACHE_FILE = resolveCacheFile();

// Attempt to migrate old 'desktop-app' cache if we are in 'ALS-Full' and it's empty
try {
  const { app } = require('electron');
  if (app && typeof app.getPath === 'function') {
    if (!fs.existsSync(CACHE_FILE) && getAppEdition() !== 'lite') {
      const oldCacheFile = path.join(app.getPath('appData'), 'desktop-app', 'local_cache.json');
      if (fs.existsSync(oldCacheFile)) {
        fs.copyFileSync(oldCacheFile, CACHE_FILE);
        console.log('[CACHE] Migrated old cache to new ALS-Full directory');
      }
    }
  }
} catch (e) {}

const DEFAULT_CACHE = {
  system_config: {
    target_url: 'https://perakamwaktu.upm.edu.my/',
    show_browser: false,
    synced: true
  },
  daily_schedule: null,
  skip_days: [],
  todays_proof: null,
  offline_logs: []
};

function readCache() {
  if (!fs.existsSync(CACHE_FILE)) {
    writeCache(DEFAULT_CACHE);
    return DEFAULT_CACHE;
  }
  try {
    const data = fs.readFileSync(CACHE_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('[CACHE] Failed to read local cache, reverting to default:', err.message);
    return DEFAULT_CACHE;
  }
}

function writeCache(data) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[CACHE] Failed to write local cache:', err.message);
  }
}

function updateCache(key, payload) {
  const cache = readCache();
  cache[key] = payload;
  writeCache(cache);
}

function mergeSystemConfig(payload, synced = true) {
  const cache = readCache();
  cache.system_config = { ...cache.system_config, ...payload, synced };
  writeCache(cache);
}

function mergeDailySchedule(payload, synced = true) {
  const cache = readCache();
  cache.daily_schedule = { ...cache.daily_schedule, ...payload, synced };
  writeCache(cache);
}

function updateSkipDays(daysArray) {
  updateCache('skip_days', daysArray);
}

function queueOfflineProof(proofPayload) {
  const cache = readCache();
  cache.todays_proof = { ...proofPayload, synced: false };
  writeCache(cache);
}

function clearProofIfSynced() {
  const cache = readCache();
  if (cache.todays_proof && cache.todays_proof.synced === false) {
    cache.todays_proof.synced = true;
    writeCache(cache);
  }
}

function logOffline(action, status, message) {
  const cache = readCache();
  cache.offline_logs.push({
    action,
    status,
    message,
    created_at: new Date().toISOString()
  });
  writeCache(cache);
}

function clearOfflineLogs() {
  const cache = readCache();
  cache.offline_logs = [];
  writeCache(cache);
}

function resolveDeviceSettingsFile() {
  if (process.env.ALS_SETTINGS_FILE) {
    return path.resolve(process.env.ALS_SETTINGS_FILE);
  }

  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'), 'local_settings.json');
    }
  } catch (error) {
    // Fall through to development path.
  }

  return path.join(__dirname, 'local_settings.json');
}

function getAppEdition() {
  if (process.env.ALS_EDITION) {
    return process.env.ALS_EDITION.toLowerCase();
  }
  try {
    const pkg = require('./package.json');
    if (pkg && pkg.edition) {
      return pkg.edition.toLowerCase();
    }
  } catch (e) {}
  return 'full';
}

function createDeviceConfig(parsed = {}, env = process.env, edition = getAppEdition()) {
  const fallbackId = parsed.device_id || env.DEVICE_ID || (edition === 'lite' ? 'lite_desktop_agent' : 'home_desktop_agent');
  return {
    device_id: fallbackId,
    device_name: parsed.device_name || env.DEVICE_NAME || (edition === 'lite' ? 'Lite Desktop Agent' : 'Home Desktop Agent'),
    upm_username: parsed.upm_username || env.UPM_USERNAME || '',
    upm_password: parsed.upm_password || env.UPM_PASSWORD || '',
    supabase_url: parsed.supabase_url || env.SUPABASE_URL || DEFAULT_SUPABASE_URL,
    supabase_key: resolveSupabasePublishableKey({
      runtimeKey: env.SUPABASE_PUBLISHABLE_KEY,
      compatibilityKey: env.SUPABASE_ANON_KEY,
      savedKey: parsed.supabase_key
    }),
    supabase_email: parsed.supabase_email || (edition === 'lite' ? '' : (env.SUPABASE_EMAIL || '')),
    supabase_password: parsed.supabase_password || (edition === 'lite' ? '' : (env.SUPABASE_PASSWORD || '')),
    target_url: parsed.target_url || env.TARGET_URL || 'https://perakamwaktu.upm.edu.my/',
    show_browser: typeof parsed.show_browser === 'boolean' ? parsed.show_browser : false,
    auto_clock_enabled: typeof parsed.auto_clock_enabled === 'boolean' ? parsed.auto_clock_enabled : true,
    clock_in_base_time: parsed.clock_in_base_time || '07:45',
    clock_out_base_time: parsed.clock_out_base_time || '17:05',
    random_period_minutes: typeof parsed.random_period_minutes === 'number' ? parsed.random_period_minutes : 5,
    edition
  };
}

const SETTINGS_FILE = resolveDeviceSettingsFile();

// Attempt to migrate old 'desktop-app' config if we are in 'ALS-Full' and it's empty
try {
  const { app } = require('electron');
  if (app && typeof app.getPath === 'function') {
    if (!fs.existsSync(SETTINGS_FILE) && getAppEdition() !== 'lite') {
      const oldSettingsFile = path.join(app.getPath('appData'), 'desktop-app', 'local_settings.json');
      if (fs.existsSync(oldSettingsFile)) {
        fs.copyFileSync(oldSettingsFile, SETTINGS_FILE);
        console.log('[CACHE] Migrated old settings to new ALS-Full directory');
      }
    }
  }
} catch (e) {}

const DEFAULT_DEVICE_CONFIG = createDeviceConfig();

function getDeviceConfig() {
  const edition = getAppEdition();
  if (!fs.existsSync(SETTINGS_FILE)) {
    return { ...DEFAULT_DEVICE_CONFIG, edition };
  }
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const resolved = createDeviceConfig(parsed, process.env, edition);

    if (parsed.supabase_key && !isSupabasePublishableKey(parsed.supabase_key)) {
      try {
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
          ...parsed,
          supabase_key: resolved.supabase_key
        }, null, 2));
        console.log('[CACHE] Replaced obsolete saved Supabase key with the publishable key.');
      } catch (migrationError) {
        console.warn('[CACHE] Could not persist the Supabase key migration:', migrationError.message);
      }
    }

    return resolved;
  } catch (err) {
    return { ...DEFAULT_DEVICE_CONFIG, edition };
  }
}

function saveDeviceConfig(config) {
  try {
    const current = getDeviceConfig();
    const merged = { ...current, ...config };
    const updated = {
      ...merged,
      ...createDeviceConfig(merged, process.env, getAppEdition())
    };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(updated, null, 2));
    return updated;
  } catch (err) {
    console.error('[CACHE] Failed to save device config:', err.message);
    throw err;
  }
}

function resolveHubAccountsFile() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      const primary = path.join(app.getPath('userData'), 'hub_accounts.json');
      if (fs.existsSync(primary)) return primary;

      // Check legacy ALS-Full path if running as Hub
      const legacyPath = path.join(app.getPath('appData'), 'ALS-Full', 'hub_accounts.json');
      if (fs.existsSync(legacyPath)) {
        try {
          fs.copyFileSync(legacyPath, primary);
          console.log('[CACHE] Migrated legacy hub_accounts.json to userData');
        } catch (e) {
          return legacyPath;
        }
      }
      return primary;
    }
  } catch (error) {}
  return path.join(require('os').homedir(), '.als_hub_accounts.json');
}

function getHubAccounts() {
  const file = resolveHubAccountsFile();
  if (!fs.existsSync(file)) return [];
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return [];
  }
}

function saveHubAccount(account) {
  const file = resolveHubAccountsFile();
  const accounts = getHubAccounts();
  const existingIndex = accounts.findIndex(a => a.device_id === account.device_id);
  if (existingIndex >= 0) {
    accounts[existingIndex] = { ...accounts[existingIndex], ...account };
  } else {
    accounts.push(account);
  }
  fs.writeFileSync(file, JSON.stringify(accounts, null, 2));
  return accounts;
}

function removeHubAccount(deviceId) {
  const file = resolveHubAccountsFile();
  let accounts = getHubAccounts();
  accounts = accounts.filter(a => a.device_id !== deviceId);
  fs.writeFileSync(file, JSON.stringify(accounts, null, 2));
  return accounts;
}

function getEngineConfig() {
  const devConfig = getDeviceConfig();
  const cache = readCache();
  const target_url = devConfig.target_url || (cache.system_config && cache.system_config.target_url) || 'https://perakamwaktu.upm.edu.my/';
  const show_browser = typeof devConfig.show_browser === 'boolean'
    ? devConfig.show_browser
    : (cache.system_config && typeof cache.system_config.show_browser === 'boolean' ? cache.system_config.show_browser : false);
  return { target_url, show_browser };
}

function saveEngineConfig(config = {}) {
  const target_url = config.target_url || config.targetUrl || 'https://perakamwaktu.upm.edu.my/';
  const show_browser = typeof config.show_browser === 'boolean'
    ? config.show_browser
    : (typeof config.showBrowser === 'boolean' ? config.showBrowser : false);
  
  saveDeviceConfig({ target_url, show_browser });
  mergeSystemConfig({ target_url, show_browser }, false);
  return { target_url, show_browser };
}

const VERSION = '1.5.8';

module.exports = {
  VERSION,
  readCache,
  writeCache,
  updateCache,
  mergeSystemConfig,
  mergeDailySchedule,
  updateSkipDays,
  queueOfflineProof,
  clearProofIfSynced,
  logOffline,
  clearOfflineLogs,
  getDeviceConfig,
  saveDeviceConfig,
  getEngineConfig,
  saveEngineConfig,
  getAppEdition,
  getHubAccounts,
  saveHubAccount,
  removeHubAccount,
  __test: {
    createDeviceConfig
  }
};
