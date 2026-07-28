const fs = require('fs');
const path = require('path');

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

const DEFAULT_CACHE = {
  system_config: {
    target_url: 'https://perakamwaktu3.upm.edu.my/',
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

const DEFAULT_SUPABASE_URL = process.env.SUPABASE_URL || 'https://pvutxjfkskzgccawfibu.supabase.co';
const DEFAULT_SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB2dXR4amZrc2t6Z2NjYXdmaWJ1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyNTY4OTMsImV4cCI6MjA5NzgzMjg5M30.FtyD9_XkLKUlBFgt5_I1cZZFhxFLRRpi9yAUbCxDJgw';

const SETTINGS_FILE = resolveDeviceSettingsFile();

const DEFAULT_DEVICE_CONFIG = {
  device_id: process.env.DEVICE_ID || 'home_desktop_agent',
  device_name: process.env.DEVICE_NAME || 'Home Desktop Agent',
  upm_username: process.env.UPM_USERNAME || '',
  upm_password: process.env.UPM_PASSWORD || '',
  supabase_url: DEFAULT_SUPABASE_URL,
  supabase_key: DEFAULT_SUPABASE_KEY,
  supabase_email: getAppEdition() === 'lite' ? '' : (process.env.SUPABASE_EMAIL || ''),
  supabase_password: getAppEdition() === 'lite' ? '' : (process.env.SUPABASE_PASSWORD || ''),
  auto_clock_enabled: true,
  clock_in_base_time: '07:45',
  clock_out_base_time: '17:05',
  random_period_minutes: 5,
  edition: getAppEdition()
};

function getDeviceConfig() {
  const edition = getAppEdition();
  if (!fs.existsSync(SETTINGS_FILE)) {
    return { ...DEFAULT_DEVICE_CONFIG, edition };
  }
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const fallbackId = parsed.device_id || process.env.DEVICE_ID || 'home_desktop_agent';
    return {
      device_id: fallbackId,
      device_name: parsed.device_name || process.env.DEVICE_NAME || 'Home Desktop Agent',
      upm_username: parsed.upm_username || process.env.UPM_USERNAME || '',
      upm_password: parsed.upm_password || process.env.UPM_PASSWORD || '',
      supabase_url: parsed.supabase_url || DEFAULT_SUPABASE_URL,
      supabase_key: parsed.supabase_key || DEFAULT_SUPABASE_KEY,
      supabase_email: parsed.supabase_email || (edition === 'lite' ? '' : (process.env.SUPABASE_EMAIL || '')),
      supabase_password: parsed.supabase_password || (edition === 'lite' ? '' : (process.env.SUPABASE_PASSWORD || '')),
      auto_clock_enabled: typeof parsed.auto_clock_enabled === 'boolean' ? parsed.auto_clock_enabled : true,
      clock_in_base_time: parsed.clock_in_base_time || '07:45',
      clock_out_base_time: parsed.clock_out_base_time || '17:05',
      random_period_minutes: typeof parsed.random_period_minutes === 'number' ? parsed.random_period_minutes : 5,
      edition: edition
    };
  } catch (err) {
    return { ...DEFAULT_DEVICE_CONFIG, edition };
  }
}

function saveDeviceConfig(config) {
  try {
    const current = getDeviceConfig();
    const updated = { ...current, ...config };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(updated, null, 2));
    return updated;
  } catch (err) {
    console.error('[CACHE] Failed to save device config:', err.message);
    throw err;
  }
}

module.exports = {
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
  getAppEdition
};

