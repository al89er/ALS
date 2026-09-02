process.env.NODE_ENV = 'test';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'als-supabase-config-'));
const settingsFile = path.join(testDir, 'local_settings.json');
process.env.ALS_SETTINGS_FILE = settingsFile;
process.env.ALS_EDITION = 'full';
delete process.env.SUPABASE_PUBLISHABLE_KEY;
delete process.env.SUPABASE_ANON_KEY;

const {
  DEFAULT_SUPABASE_URL,
  DEFAULT_SUPABASE_PUBLISHABLE_KEY,
  isLegacyJwtLike,
  isSupabasePublishableKey,
  isSupabaseSecretKey,
  resolveSupabasePublishableKey
} = require('../supabase-config');
const cacheManager = require('../cache-manager');
const { createBundledEnv } = require('../prebuild');

function fakeLegacyJwt() {
  return ['eyJfixture', 'payload', 'signature'].join('.');
}

function fakeSecretKey() {
  return ['sb', 'secret', 'fixture'].join('_');
}

test.after(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

test('recognizes only modern publishable keys as desktop client keys', () => {
  assert.equal(isSupabasePublishableKey('sb_publishable_runtime'), true);
  assert.equal(isSupabasePublishableKey(fakeLegacyJwt()), false);
  assert.equal(isSupabasePublishableKey(fakeSecretKey()), false);
  assert.equal(isLegacyJwtLike(fakeLegacyJwt()), true);
  assert.equal(isSupabaseSecretKey(fakeSecretKey()), true);
});

test('resolves runtime, compatibility, saved, and fallback keys in priority order', () => {
  assert.equal(resolveSupabasePublishableKey({
    runtimeKey: 'sb_publishable_runtime',
    savedKey: 'sb_publishable_saved'
  }), 'sb_publishable_runtime');

  assert.equal(resolveSupabasePublishableKey({
    compatibilityKey: 'sb_publishable_compatibility',
    savedKey: 'sb_publishable_saved'
  }), 'sb_publishable_compatibility');

  assert.equal(resolveSupabasePublishableKey({
    runtimeKey: fakeSecretKey(),
    compatibilityKey: fakeLegacyJwt(),
    savedKey: 'sb_publishable_saved'
  }), 'sb_publishable_saved');

  assert.equal(resolveSupabasePublishableKey({
    savedKey: fakeLegacyJwt()
  }), DEFAULT_SUPABASE_PUBLISHABLE_KEY);
});

test('migrates an obsolete local settings key without changing other settings', () => {
  fs.writeFileSync(settingsFile, JSON.stringify({
    device_id: 'existing-full-device',
    device_name: 'Existing Full Device',
    supabase_url: DEFAULT_SUPABASE_URL,
    supabase_key: fakeLegacyJwt(),
    auto_clock_enabled: false
  }));

  const config = cacheManager.getDeviceConfig();
  const migrated = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));

  assert.equal(config.supabase_key, DEFAULT_SUPABASE_PUBLISHABLE_KEY);
  assert.equal(migrated.supabase_key, DEFAULT_SUPABASE_PUBLISHABLE_KEY);
  assert.equal(migrated.device_id, 'existing-full-device');
  assert.equal(migrated.auto_clock_enabled, false);
});

test('preserves a modern saved key and applies runtime precedence for Full and Hub', () => {
  const savedKey = 'sb_publishable_saved';
  fs.writeFileSync(settingsFile, JSON.stringify({
    device_id: 'saved-device',
    supabase_key: savedKey
  }));

  assert.equal(cacheManager.getDeviceConfig().supabase_key, savedKey);
  assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).supabase_key, savedKey);

  for (const edition of ['full', 'hub']) {
    const config = cacheManager.__test.createDeviceConfig({
      device_id: `${edition}-device`,
      supabase_key: savedKey
    }, {
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_runtime'
    }, edition);

    assert.equal(config.edition, edition);
    assert.equal(config.supabase_key, 'sb_publishable_runtime');
  }
});

test('generates a sanitized bundled environment for packaged clients', () => {
  const source = [
    `SUPABASE_URL=https://legacy.example.invalid`,
    `SUPABASE_ANON_KEY=${fakeLegacyJwt()}`,
    `SUPABASE_SERVICE_ROLE_KEY=${fakeLegacyJwt()}`,
    `UNRELATED_SECRET=${fakeSecretKey()}`,
    'UPM_USERNAME=fixture-user'
  ].join('\n');
  const bundled = createBundledEnv(source);

  assert.match(bundled, new RegExp(`SUPABASE_URL=${DEFAULT_SUPABASE_URL}`));
  assert.match(bundled, new RegExp(`SUPABASE_PUBLISHABLE_KEY=${DEFAULT_SUPABASE_PUBLISHABLE_KEY}`));
  assert.match(bundled, /UPM_USERNAME=fixture-user/);
  assert.doesNotMatch(bundled, /SUPABASE_ANON_KEY/);
  assert.doesNotMatch(bundled, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(bundled, /eyJfixture/);
  assert.doesNotMatch(bundled, /sb_secret_fixture/);
});

test('Full and Hub runtime source retains authenticated client isolation', () => {
  const fullSource = fs.readFileSync(path.join(__dirname, '..', 'supabase-client.js'), 'utf8');
  const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'desktop-ui.html'), 'utf8');
  const hubSource = fs.readFileSync(path.join(__dirname, '..', 'hub-client.js'), 'utf8');

  assert.match(fullSource, /auth\.signInWithPassword/);
  assert.match(rendererSource, /SUPABASE_PUBLISHABLE_KEY/);
  assert.match(hubSource, /createClient\(supabaseUrl, supabaseKey/);
  assert.match(hubSource, /persistSession:\s*false/);
  assert.match(hubSource, /auth\.signInWithPassword/);
});

test('packaging excludes local configuration and debug/test utilities', () => {
  const packageJson = require('../package.json');
  for (const exclusion of ['!**/.env', '!**/debug_*.js', '!**/test_*.js', '!**/patch.js', '!**/local_settings.json']) {
    assert.equal(packageJson.build.files.includes(exclusion), true);
  }
});
