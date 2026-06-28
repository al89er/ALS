const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, 'local_cache.json');

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

module.exports = {
  readCache,
  writeCache,
  mergeSystemConfig,
  mergeDailySchedule,
  updateSkipDays,
  queueOfflineProof,
  clearProofIfSynced,
  logOffline,
  clearOfflineLogs
};
