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

function getActiveCacheFile() {
  if (process.env.ALS_CACHE_FILE) {
    return path.resolve(process.env.ALS_CACHE_FILE);
  }
  return CACHE_FILE;
}

const DEFAULT_WEEKLY_DEFAULTS = {
  '0': 'full_skip',
  '1': 'normal',
  '2': 'normal',
  '3': 'normal',
  '4': 'normal',
  '5': 'normal',
  '6': 'full_skip'
};

function createDefaultSchedulePolicy() {
  return {
    revision: 1,
    applied_revision: 0,
    applied_at: null,
    ack_status: 'pending',
    ack_message: null,
    weekly_defaults: { ...DEFAULT_WEEKLY_DEFAULTS },
    date_overrides: {},
    recurring_rules: [],
    holidays: {},
    schema_ready: true,
    synced: true
  };
}

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
  schedule_policy: createDefaultSchedulePolicy(),
  todays_proof: null,
  offline_logs: []
};

function cloneDefaultCache() {
  return JSON.parse(JSON.stringify(DEFAULT_CACHE));
}

function readCache() {
  const activeFile = getActiveCacheFile();
  if (!fs.existsSync(activeFile)) {
    const initial = cloneDefaultCache();
    writeCache(initial);
    return initial;
  }
  try {
    const data = fs.readFileSync(activeFile, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('[CACHE] Failed to read local cache, reverting to default:', err.message);
    return cloneDefaultCache();
  }
}

function writeCache(data) {
  const activeFile = getActiveCacheFile();
  try {
    fs.writeFileSync(activeFile, JSON.stringify(data, null, 2));
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
  const cleanPayload = { ...(payload || {}) };
  const allowResetDone = cleanPayload._allowResetDone === true;
  delete cleanPayload._allowResetDone;

  const existing = cache.daily_schedule;
  const sameDay = existing && (!cleanPayload.date || existing.date === cleanPayload.date);

  const merged = sameDay ? { ...existing, ...cleanPayload, synced } : { ...cleanPayload, synced };

  if (sameDay && !allowResetDone) {
    if (existing.clock_in_done === true) merged.clock_in_done = true;
    if (existing.clock_out_done === true) merged.clock_out_done = true;
    if (existing.planned_clock_in && !merged.planned_clock_in) merged.planned_clock_in = existing.planned_clock_in;
    if (existing.planned_clock_out && !merged.planned_clock_out) merged.planned_clock_out = existing.planned_clock_out;
  }

  cache.daily_schedule = merged;
  writeCache(cache);
  return merged;
}

function normalizeWeeklyDefaults(rawDefaults) {
  const normalized = { ...DEFAULT_WEEKLY_DEFAULTS };
  if (rawDefaults && typeof rawDefaults === 'object') {
    for (let i = 0; i <= 6; i++) {
      const k = String(i);
      const val = rawDefaults[k] !== undefined ? rawDefaults[k] : rawDefaults[i];
      if (val === 'normal' || val === 'full_skip' || val === 'clock_in_only' || val === 'clock_out_only') {
        normalized[k] = val;
      }
    }
  }
  return normalized;
}

function getSchedulePolicy() {
  const cache = readCache();
  const base = createDefaultSchedulePolicy();
  const stored = (cache && cache.schedule_policy && typeof cache.schedule_policy === 'object')
    ? cache.schedule_policy
    : {};

  const overrides = {};
  if (stored.date_overrides && typeof stored.date_overrides === 'object') {
    for (const [dateStr, entry] of Object.entries(stored.date_overrides)) {
      if (entry && typeof entry === 'object' && entry.mode) {
        overrides[dateStr] = { ...entry, date: entry.date || dateStr };
      }
    }
  }

  if (Array.isArray(cache.skip_days)) {
    for (const skipDate of cache.skip_days) {
      if (typeof skipDate === 'string' && skipDate && !overrides[skipDate]) {
        overrides[skipDate] = {
          date: skipDate,
          mode: 'full_skip',
          source: 'legacy_skip_day',
          reason: 'Migrated from legacy skip_days'
        };
      }
    }
  }

  return {
    ...base,
    ...stored,
    revision: Number(stored.revision || base.revision) || 1,
    applied_revision: Number(stored.applied_revision || 0) || 0,
    weekly_defaults: normalizeWeeklyDefaults(stored.weekly_defaults),
    date_overrides: overrides,
    recurring_rules: Array.isArray(stored.recurring_rules) ? stored.recurring_rules.map(r => ({ ...r })) : [],
    holidays: (stored.holidays && typeof stored.holidays === 'object') ? { ...stored.holidays } : {}
  };
}

function saveSchedulePolicy(patch = {}, synced = true) {
  const cache = readCache();
  const current = getSchedulePolicy();
  const next = {
    ...current,
    ...patch,
    weekly_defaults: normalizeWeeklyDefaults(patch.weekly_defaults || current.weekly_defaults),
    date_overrides: patch.date_overrides ? { ...patch.date_overrides } : { ...current.date_overrides },
    recurring_rules: Array.isArray(patch.recurring_rules) ? patch.recurring_rules.map(r => ({ ...r })) : current.recurring_rules,
    holidays: patch.holidays ? { ...patch.holidays } : { ...current.holidays },
    synced
  };

  cache.schedule_policy = next;

  // Keep legacy skip_days aligned with full_skip overrides (including approved full_skip holidays)
  if (patch.date_overrides !== undefined || patch.holidays !== undefined || patch._syncSkipDays === true) {
    const legacySkips = new Set();
    for (const [dateStr, entry] of Object.entries(next.date_overrides)) {
      if (entry && entry.mode === 'full_skip') legacySkips.add(dateStr);
    }
    cache.skip_days = Array.from(legacySkips).sort();
  }

  writeCache(cache);
  return next;
}

function updateSkipDays(daysArray) {
  const cache = readCache();
  const normalizedList = Array.isArray(daysArray) ? [...daysArray] : [];
  cache.skip_days = normalizedList;

  const policy = getSchedulePolicy();
  const nextOverrides = {};
  for (const [dateStr, entry] of Object.entries(policy.date_overrides)) {
    if (entry && entry.source !== 'legacy_skip_day') {
      nextOverrides[dateStr] = entry;
    }
  }
  for (const d of normalizedList) {
    if (typeof d === 'string' && d && !nextOverrides[d]) {
      nextOverrides[d] = {
        date: d,
        mode: 'full_skip',
        source: 'legacy_skip_day',
        reason: 'Synced from skip_days'
      };
    }
  }
  policy.date_overrides = nextOverrides;
  cache.schedule_policy = policy;
  writeCache(cache);
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
    telegram_bot_token: parsed.telegram_bot_token || env.TELEGRAM_BOT_TOKEN || '',
    telegram_chat_id: parsed.telegram_chat_id || env.TELEGRAM_CHAT_ID || '',
    edition
  };
}

const SETTINGS_FILE = resolveDeviceSettingsFile();

function getActiveSettingsFile() {
  if (process.env.ALS_SETTINGS_FILE) {
    return path.resolve(process.env.ALS_SETTINGS_FILE);
  }
  return SETTINGS_FILE;
}

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
  const activeSettingsFile = getActiveSettingsFile();
  if (!fs.existsSync(activeSettingsFile)) {
    return { ...createDeviceConfig({}, process.env, edition), edition };
  }
  try {
    const raw = fs.readFileSync(activeSettingsFile, 'utf8');
    const parsed = JSON.parse(raw);
    const resolved = createDeviceConfig(parsed, process.env, edition);

    if (parsed.supabase_key && !isSupabasePublishableKey(parsed.supabase_key)) {
      try {
        fs.writeFileSync(activeSettingsFile, JSON.stringify({
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
    return { ...createDeviceConfig({}, process.env, edition), edition };
  }
}

function saveDeviceConfig(config) {
  try {
    const activeSettingsFile = getActiveSettingsFile();
    const current = getDeviceConfig();
    const merged = { ...current, ...config };
    const updated = {
      ...merged,
      ...createDeviceConfig(merged, process.env, getAppEdition())
    };
    fs.writeFileSync(activeSettingsFile, JSON.stringify(updated, null, 2));

    if (config && config._triggerTelegramTest) {
      try {
        const automation = require('./automation');
        if (typeof automation.testTelegramAlert === 'function') {
          return automation.testTelegramAlert({
            botToken: updated.telegram_bot_token,
            chatId: updated.telegram_chat_id,
            message: config.testMessage
          }).then(res => ({ ...updated, telegramTestResult: res }))
            .catch(err => ({ ...updated, telegramTestResult: { success: false, error: err.message } }));
        }
      } catch (testErr) {
        return { ...updated, telegramTestResult: { success: false, error: testErr.message } };
      }
    }

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

function getProofImagesDir() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      const proofsDir = path.join(app.getPath('userData'), 'proofs');
      if (!fs.existsSync(proofsDir)) fs.mkdirSync(proofsDir, { recursive: true });
      return proofsDir;
    }
  } catch (_) {}
  const fallback = path.join(require('os').tmpdir(), 'als-proofs');
  if (!fs.existsSync(fallback)) fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

function saveProofThumbnail(buffer, dateStr) {
  if (!buffer || !Buffer.isBuffer(buffer)) return null;
  const date = dateStr || new Date().toISOString().split('T')[0];
  const dataUrl = `data:image/jpeg;base64,${buffer.toString('base64')}`;
  try {
    const dir = getProofImagesDir();
    const filePath = path.join(dir, `proof_${date}.jpg`);
    const latestPath = path.join(dir, 'proof_latest.jpg');
    fs.writeFileSync(filePath, buffer);
    fs.writeFileSync(latestPath, buffer);
    return { filePath, dataUrl, date };
  } catch (err) {
    console.warn('[CACHE] Could not save proof thumbnail to disk:', err.message);
    return { dataUrl, date, filePath: null };
  }
}

function getLatestProofImage(dateStr) {
  try {
    const dir = getProofImagesDir();
    let targetPath = path.join(dir, 'proof_latest.jpg');
    if (dateStr) {
      const specific = path.join(dir, `proof_${dateStr}.jpg`);
      if (fs.existsSync(specific)) targetPath = specific;
    }
    if (fs.existsSync(targetPath)) {
      const buf = fs.readFileSync(targetPath);
      return {
        dataUrl: `data:image/jpeg;base64,${buf.toString('base64')}`,
        filePath: targetPath,
        date: dateStr || new Date().toISOString().split('T')[0]
      };
    }
  } catch (_) {}
  return null;
}

const VERSION = '1.7.0';

module.exports = {
  VERSION,
  DEFAULT_WEEKLY_DEFAULTS,
  readCache,
  writeCache,
  updateCache,
  mergeSystemConfig,
  mergeDailySchedule,
  updateSkipDays,
  getSchedulePolicy,
  saveSchedulePolicy,
  queueOfflineProof,
  clearProofIfSynced,
  logOffline,
  clearOfflineLogs,
  getDeviceConfig,
  saveDeviceConfig,
  getEngineConfig,
  saveEngineConfig,
  getProofImagesDir,
  saveProofThumbnail,
  getLatestProofImage,
  getAppEdition,
  getHubAccounts,
  saveHubAccount,
  removeHubAccount,
  __test: {
    createDeviceConfig,
    normalizeWeeklyDefaults
  }
};
