const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'als-sched-recovery-test-'));
process.env.ALS_CACHE_FILE = path.join(tempDir, 'local_cache.json');
process.env.ALS_SETTINGS_FILE = path.join(tempDir, 'settings.json');
process.env.ALS_EDITION = 'full';

global.fetch = async (url) => {
  throw new Error(`REAL_NETWORK_BLOCKED_IN_TEST: ${url}`);
};

function createMockSupabase() {
  const db = {
    system_config: [{
      device_id: 'home_desktop_agent',
      auto_clock_enabled: true,
      clock_in_base_time: '07:45',
      clock_out_base_time: '17:05',
      random_period_minutes: 0
    }],
    schedule_policy_state: [{
      device_id: 'home_desktop_agent',
      revision: 1,
      applied_revision: 0,
      ack_status: 'pending',
      ack_message: null,
      weekly_defaults: {
        '0': 'normal', '1': 'normal', '2': 'normal', '3': 'normal',
        '4': 'normal', '5': 'normal', '6': 'normal'
      },
      policy_updated_at: new Date().toISOString()
    }],
    schedule_date_overrides: [],
    schedule_recurring_rules: [],
    schedule_holidays: [],
    skip_days: [],
    daily_schedules: [],
    todays_proof: [],
    device_status: [],
    commands: [],
    logs: []
  };

  let offlineError = null;
  let authShouldFail = false;

  const clone = (v) => JSON.parse(JSON.stringify(v));

  function applyFilters(rows, filters) {
    return rows.filter((row) => {
      for (const f of filters) {
        if (f.type === 'eq' && row[f.col] !== f.val) return false;
        if (f.type === 'or') {
          const parts = f.expr.split(',').map((s) => s.trim());
          const ok = parts.some((p) => {
            if (p.includes('.eq.')) {
              const [c, v] = p.split('.eq.');
              return row[c] === v;
            }
            if (p.includes('.is.null')) {
              const c = p.replace('.is.null', '');
              return row[c] === null || row[c] === undefined;
            }
            return false;
          });
          if (!ok) return false;
        }
      }
      return true;
    });
  }

  function upsertRow(table, payload) {
    const rows = db[table];
    let idx = -1;
    if (table === 'daily_schedules' || table === 'todays_proof') {
      idx = rows.findIndex((r) => r.date === payload.date && (r.device_id || 'home_desktop_agent') === (payload.device_id || 'home_desktop_agent'));
    } else if (table === 'schedule_date_overrides') {
      idx = rows.findIndex((r) => r.date === payload.date && r.device_id === payload.device_id);
    } else if (table === 'schedule_policy_state' || table === 'system_config' || table === 'device_status') {
      idx = rows.findIndex((r) => (r.device_id || r.id) === (payload.device_id || payload.id));
    } else if (payload.id) {
      idx = rows.findIndex((r) => r.id === payload.id);
    }
    const stored = { ...payload };
    if (idx >= 0) {
      rows[idx] = { ...rows[idx], ...stored };
      return rows[idx];
    }
    rows.push(stored);
    return stored;
  }

  function createQueryBuilder(table) {
    const state = { op: 'select', filters: [], orders: [], limitCount: null, singleMode: null, payload: null };
    const builder = {
      select() { return builder; },
      insert(p) { state.op = 'insert'; state.payload = p; return builder; },
      upsert(p) { state.op = 'upsert'; state.payload = p; return builder; },
      update(p) { state.op = 'update'; state.payload = p; return builder; },
      delete() { state.op = 'delete'; return builder; },
      eq(col, val) { state.filters.push({ type: 'eq', col, val }); return builder; },
      or(expr) { state.filters.push({ type: 'or', expr }); return builder; },
      order(col, opts = {}) { state.orders.push({ col, ascending: opts.ascending !== false }); return builder; },
      limit(n) { state.limitCount = n; return builder; },
      maybeSingle() { state.singleMode = 'maybeSingle'; return builder; },
      single() { state.singleMode = 'single'; return builder; },
      async _execute() {
        if (offlineError) return { data: null, error: { message: offlineError } };
        const rows = db[table];
        if (!rows) return { data: null, error: { message: `Unknown table ${table}` } };
        if (state.op === 'select') {
          let res = applyFilters(rows, state.filters);
          for (const ord of state.orders) {
            res = [...res].sort((a, b) => (a[ord.col] === b[ord.col] ? 0 : (a[ord.col] < b[ord.col] ? -1 : 1) * (ord.ascending ? 1 : -1)));
          }
          if (state.limitCount !== null) res = res.slice(0, state.limitCount);
          const out = clone(res);
          if (state.singleMode === 'maybeSingle') return { data: out[0] || null, error: null };
          if (state.singleMode === 'single') return out[0] ? { data: out[0], error: null } : { data: null, error: { code: 'PGRST116' } };
          return { data: out, error: null };
        }
        if (state.op === 'insert' || state.op === 'upsert') {
          const items = Array.isArray(state.payload) ? state.payload : [state.payload];
          const saved = items.map((item) => upsertRow(table, item));
          const out = clone(saved);
          return { data: state.singleMode ? out[0] : out, error: null };
        }
        if (state.op === 'update') {
          const matched = applyFilters(rows, state.filters);
          for (const r of matched) Object.assign(r, state.payload);
          const out = clone(matched);
          return { data: state.singleMode ? (out[0] || null) : out, error: null };
        }
        if (state.op === 'delete') {
          const matched = applyFilters(rows, state.filters);
          db[table] = rows.filter((r) => !matched.includes(r));
          return { data: clone(matched), error: null };
        }
        return { data: null, error: null };
      },
      then(resolve, reject) {
        return builder._execute().then(resolve, reject);
      }
    };
    return builder;
  }

  return {
    db,
    setOffline(msg) { offlineError = msg; },
    setAuthShouldFail(flag) { authShouldFail = flag; },
    from(table) { return createQueryBuilder(table); },
    auth: {
      async signInWithPassword() {
        if (authShouldFail) return { data: null, error: { message: 'Network auth timeout' } };
        return { data: { session: { access_token: 'mock-jwt' } }, error: null };
      },
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; }
    },
    realtime: { setAuth() {} },
    channel(name) {
      const ch = { name, state: 'joined', on() { return ch; }, subscribe(cb) { if (cb) cb('SUBSCRIBED'); return ch; } };
      return ch;
    },
    removeChannel() {}
  };
}

const mockSupabase = createMockSupabase();
const supabasePkgPath = require.resolve('@supabase/supabase-js', { paths: [path.join(__dirname, '..')] });
require.cache[supabasePkgPath] = {
  id: supabasePkgPath,
  filename: supabasePkgPath,
  loaded: true,
  exports: { createClient: () => mockSupabase }
};

const cacheManager = require('../cache-manager');
const scheduler = require('../scheduler');
const supabaseClient = require('../supabase-client');

function getTodayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getSameDayTimeOffset(minutesOffset) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 0, 0);
  let target = new Date(now.getTime() + minutesOffset * 60000);
  if (target > todayEnd) target = todayEnd;
  if (target < todayStart) target = todayStart;
  return `${String(target.getHours()).padStart(2, '0')}:${String(target.getMinutes()).padStart(2, '0')}`;
}

function createFakeCronHarness() {
  const registered = [];
  const cronSchedule = (expr, cb) => {
    const task = { expr, cb, stopped: false, stop() { task.stopped = true; } };
    registered.push(task);
    return task;
  };
  return { registered, cronSchedule };
}

function resetState(inOffset = 30, outOffset = 120) {
  scheduler.__test.stopCronJobs();
  scheduler.__test.resetRuntimeDependencies();
  scheduler.__test.resetSchedulerStateForTest();
  supabaseClient.__test.resetAuthStateForTest();
  supabaseClient.__test.resetRuntimeDependencies();

  mockSupabase.setOffline(null);
  mockSupabase.setAuthShouldFail(false);
  mockSupabase.db.schedule_date_overrides = [];
  mockSupabase.db.schedule_recurring_rules = [];
  mockSupabase.db.schedule_holidays = [];
  mockSupabase.db.skip_days = [];
  mockSupabase.db.daily_schedules = [];
  mockSupabase.db.todays_proof = [];
  mockSupabase.db.commands = [];
  mockSupabase.db.logs = [];
  mockSupabase.db.schedule_policy_state = [{
    device_id: 'home_desktop_agent',
    revision: 1,
    applied_revision: 0,
    ack_status: 'pending',
    weekly_defaults: { '0': 'normal', '1': 'normal', '2': 'normal', '3': 'normal', '4': 'normal', '5': 'normal', '6': 'normal' }
  }];

  const tIn = getSameDayTimeOffset(inOffset);
  const tOut = getSameDayTimeOffset(outOffset);
  process.env.ALS_EDITION = 'full';
  cacheManager.saveDeviceConfig({
    device_id: 'home_desktop_agent',
    device_name: 'Home Desktop',
    edition: 'full',
    auto_clock_enabled: true,
    supabase_email: 'muhammadafif@upm.edu.my',
    supabase_password: 'secret',
    clock_in_base_time: tIn,
    clock_out_base_time: tOut,
    random_period_minutes: 0
  });
  cacheManager.writeCache({
    last_synced: null,
    daily_schedule: null,
    system_config: { clock_in_base_time: tIn, clock_out_base_time: tOut, random_period_minutes: 0 },
    skip_days: [],
    schedule_policy: {
      revision: 0,
      weekly_defaults: { '0': 'normal', '1': 'normal', '2': 'normal', '3': 'normal', '4': 'normal', '5': 'normal', '6': 'normal' },
      date_overrides: {},
      recurring_rules: [],
      holidays: {}
    },
    todays_proof: null,
    offline_proofs: [],
    offline_logs: []
  });
  global.connectivityState = 'Connected to Supabase';
  return { tIn, tOut, todayStr: getTodayStr() };
}

test.after(() => {
  scheduler.__test.stopCronJobs();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
});

test('1. App starts with no schedule for an active working day -> generates schedule, arms jobs, and reports healthy', async () => {
  const { todayStr } = resetState(30, 120);
  const harness = createFakeCronHarness();
  scheduler.__test.setRuntimeDependenciesForTest({ cronSchedule: harness.cronSchedule });

  assert.equal(mockSupabase.db.daily_schedules.length, 0);
  await scheduler.init(mockSupabase);

  const diag = scheduler.getDiagnosticsSnapshot();
  assert.equal(diag.initialized, true);
  assert.equal(diag.healthStatus, 'healthy');
  assert.equal(diag.todayDate, todayStr);
  assert.equal(diag.clockIn.cronRegistered, true);
  assert.equal(diag.clockOut.cronRegistered, true);
  assert.equal(mockSupabase.db.daily_schedules.length, 1);
  assert.ok(mockSupabase.db.daily_schedules[0].scheduled_clock_in);
  assert.ok(mockSupabase.db.daily_schedules[0].scheduled_clock_out);
});

test('2. Existing schedule contains missing times unexpectedly -> self-healing repairs times and arms cron jobs', async () => {
  const { todayStr } = resetState(35, 120);
  const harness = createFakeCronHarness();
  scheduler.__test.setRuntimeDependenciesForTest({ cronSchedule: harness.cronSchedule });

  mockSupabase.db.daily_schedules = [{
    date: todayStr,
    device_id: 'home_desktop_agent',
    skipped: false,
    effective_mode: 'normal',
    scheduled_clock_in: null,
    scheduled_clock_out: null,
    planned_clock_in: null,
    planned_clock_out: null,
    clock_in_done: false,
    clock_out_done: false,
    clock_in_status: 'pending',
    clock_out_status: 'pending'
  }];

  await scheduler.init(mockSupabase);
  const diag = scheduler.getDiagnosticsSnapshot();
  assert.equal(diag.healthStatus, 'healthy');
  assert.ok(diag.clockIn.scheduledTime);
  assert.ok(diag.clockOut.scheduledTime);
  assert.equal(diag.clockIn.cronRegistered, true);
  assert.equal(diag.clockOut.cronRegistered, true);
});

test('3 & 4. Supabase unavailable at startup -> degraded retrieval_failure -> reconnect auto-heals without restart', async () => {
  const { todayStr } = resetState(40, 130);
  const harness = createFakeCronHarness();
  scheduler.__test.setRuntimeDependenciesForTest({ cronSchedule: harness.cronSchedule });

  // Startup while Supabase & auth are offline
  mockSupabase.setOffline('ECONNREFUSED');
  mockSupabase.setAuthShouldFail(true);
  global.connectivityState = 'Pending Connection';

  await supabaseClient.initSupabase();
  await scheduler.init(mockSupabase);

  const diagOffline = scheduler.getDiagnosticsSnapshot();
  assert.equal(diagOffline.initialized, true);
  assert.equal(diagOffline.healthStatus, 'degraded');
  assert.equal(diagOffline.lastErrorCategory, 'retrieval_failure');

  // Supabase & auth recover without restarting app/Windows
  mockSupabase.setOffline(null);
  mockSupabase.setAuthShouldFail(false);

  const hb = await supabaseClient.__test.pingHeartbeatOnce();
  assert.equal(hb.online, true);
  assert.equal(hb.justAuthenticated, true);

  const diagRecovered = scheduler.getDiagnosticsSnapshot();
  assert.equal(diagRecovered.healthStatus, 'healthy');
  assert.equal(diagRecovered.lastError, null);
  assert.equal(mockSupabase.db.daily_schedules.length, 1);
  assert.equal(mockSupabase.db.daily_schedules[0].date, todayStr);
});

test('5. UI reloads while scheduler remains active & health check repairs unexpectedly missing cron job', async () => {
  resetState(45, 120);
  const harness = createFakeCronHarness();
  scheduler.__test.setRuntimeDependenciesForTest({ cronSchedule: harness.cronSchedule });

  await scheduler.init(mockSupabase);
  const diag1 = scheduler.getDiagnosticsSnapshot();
  assert.equal(diag1.healthStatus, 'healthy');
  assert.equal(diag1.clockOut.cronRegistered, true);

  // Simulate lost in-memory cron job while schedule row says pending
  const state = scheduler.__test.getSchedulerState();
  state.clockOutTask = null;

  const healRes = await scheduler.runHealthCheck(mockSupabase);
  assert.equal(healRes.recovered, true);
  assert.equal(healRes.healthy, true);
  assert.equal(scheduler.getDiagnosticsSnapshot().clockOut.cronRegistered, true);
});

test('6. Desktop resumes after Windows sleep -> reconciles schedule safely', async () => {
  const { todayStr } = resetState(45, 130);
  const harness = createFakeCronHarness();
  scheduler.__test.setRuntimeDependenciesForTest({ cronSchedule: harness.cronSchedule });

  await scheduler.init(mockSupabase);

  // Override changed while desktop slept
  mockSupabase.db.schedule_date_overrides = [{ device_id: 'home_desktop_agent', date: todayStr, mode: 'clock_in_only' }];
  mockSupabase.db.schedule_policy_state[0].revision = 2;

  await scheduler.reconcileSchedule(mockSupabase, { triggerSource: 'os_power_resume', checkMissed: true, force: true });
  const diag = scheduler.getDiagnosticsSnapshot();
  assert.equal(diag.healthStatus, 'healthy');
  assert.equal(diag.effectiveMode, 'clock_in_only');
  assert.equal(diag.clockOut.cronRegistered, false);
  assert.equal(diag.clockIn.cronRegistered, true);
});

test('7, 8 & 9. Manual clock-in completed before recovery -> preserved, never repeated, & pending clock-out restored', async () => {
  const { todayStr } = resetState(30, 120);
  const clockCalls = [];
  const harness = createFakeCronHarness();
  scheduler.__test.setRuntimeDependenciesForTest({
    cronSchedule: harness.cronSchedule,
    executeClockAction: async (action) => { clockCalls.push(action); return true; }
  });

  // Only verified portal proof exists (no daily_schedules row yet!)
  mockSupabase.db.todays_proof = [{
    date: todayStr,
    device_id: 'home_desktop_agent',
    clock_in: '07:42:18',
    clock_out: null
  }];

  await scheduler.init(mockSupabase);
  const diag = scheduler.getDiagnosticsSnapshot();
  assert.equal(diag.healthStatus, 'healthy');
  assert.equal(diag.clockIn.done, true);
  assert.equal(diag.clockIn.status, 'completed');
  assert.equal(diag.clockIn.cronRegistered, false, 'completed manual clock-in must NOT arm auto clock-in');
  assert.equal(diag.clockOut.done, false);
  assert.equal(diag.clockOut.cronRegistered, true, 'pending clock-out on normal day must be armed');
  assert.equal(mockSupabase.db.daily_schedules[0].clock_in_done, true);
  assert.equal(clockCalls.length, 0);

  // If policy is clock_in_only, clock-out must NOT be armed
  mockSupabase.db.schedule_date_overrides = [{ device_id: 'home_desktop_agent', date: todayStr, mode: 'clock_in_only' }];
  mockSupabase.db.schedule_policy_state[0].revision = 2;
  await scheduler.reconcileSchedule(mockSupabase, { triggerSource: 'policy_change', force: true });
  assert.equal(scheduler.getDiagnosticsSnapshot().clockOut.cronRegistered, false);
});

test('10 & 11. Full Skip & Clock-in Only intentional null times are NOT treated as corruption', async () => {
  const { todayStr } = resetState(35, 120);
  const harness = createFakeCronHarness();
  scheduler.__test.setRuntimeDependenciesForTest({ cronSchedule: harness.cronSchedule });

  // Full Skip
  mockSupabase.db.schedule_date_overrides = [{ device_id: 'home_desktop_agent', date: todayStr, mode: 'full_skip' }];
  await scheduler.init(mockSupabase);

  let health = await scheduler.runHealthCheck(mockSupabase);
  assert.equal(health.healthy, true);
  assert.equal(health.recovered, false);
  assert.equal(scheduler.getDiagnosticsSnapshot().effectiveMode, 'full_skip');
  assert.equal(mockSupabase.db.daily_schedules[0].scheduled_clock_in, null);
  assert.equal(mockSupabase.db.daily_schedules[0].scheduled_clock_out, null);

  // Clock-in Only
  mockSupabase.db.schedule_date_overrides = [{ device_id: 'home_desktop_agent', date: todayStr, mode: 'clock_in_only' }];
  mockSupabase.db.schedule_policy_state[0].revision = 2;
  await scheduler.reconcileSchedule(mockSupabase, { triggerSource: 'policy_change', force: true });

  health = await scheduler.runHealthCheck(mockSupabase);
  assert.equal(health.healthy, true);
  assert.equal(health.recovered, false);
  assert.equal(scheduler.getDiagnosticsSnapshot().effectiveMode, 'clock_in_only');
  assert.equal(mockSupabase.db.daily_schedules[0].scheduled_clock_out, null);
  assert.equal(scheduler.getDiagnosticsSnapshot().clockOut.cronRegistered, false);
});

test('12. Repeated recovery attempts do not register duplicate cron jobs', async () => {
  resetState(40, 120);
  const harness = createFakeCronHarness();
  scheduler.__test.setRuntimeDependenciesForTest({ cronSchedule: harness.cronSchedule });

  await scheduler.init(mockSupabase);
  const initialDiag = scheduler.getDiagnosticsSnapshot();
  const initialCount = harness.registered.filter((t) => !t.stopped && t.expr !== '0 0 * * *').length;
  assert.equal(initialCount, 3, 'exactly 1 clockIn + 1 diagnostic + 1 clockOut task active');

  // Run multiple repeated reconciliations & health checks
  await scheduler.reconcileSchedule(mockSupabase, { triggerSource: 'recheck_1', force: true });
  await scheduler.reconcileSchedule(mockSupabase, { triggerSource: 'recheck_2', force: true });
  await scheduler.runHealthCheck(mockSupabase);

  const activeCount = harness.registered.filter((t) => !t.stopped && t.expr !== '0 0 * * *').length;
  assert.equal(activeCount, initialCount, 'must never accumulate duplicate active cron tasks');
  const afterDiag = scheduler.getDiagnosticsSnapshot();
  assert.equal(afterDiag.clockIn.jobId, initialDiag.clockIn.jobId, 'healthy clockIn jobId must remain unchanged');
  assert.equal(afterDiag.clockOut.jobId, initialDiag.clockOut.jobId, 'healthy clockOut jobId must remain unchanged');
});

test('13. Expired scheduled times mark missed_window and never auto-trigger catch-up', async () => {
  const { todayStr } = resetState(-60, 120);
  const pastTime = new Date().getHours() === 0 && new Date().getMinutes() < 2 ? '00:00' : '00:01';
  cacheManager.saveDeviceConfig({
    device_id: 'home_desktop_agent',
    device_name: 'Home Desktop',
    edition: 'full',
    auto_clock_enabled: true,
    clock_in_base_time: pastTime,
    clock_out_base_time: getSameDayTimeOffset(120),
    random_period_minutes: 0
  });

  const clockCalls = [];
  const harness = createFakeCronHarness();
  scheduler.__test.setRuntimeDependenciesForTest({
    cronSchedule: harness.cronSchedule,
    executeClockAction: async (action) => { clockCalls.push(action); return true; }
  });

  await scheduler.init(mockSupabase);
  if (pastTime !== '00:00' || new Date().getMinutes() > 0) {
    assert.equal(mockSupabase.db.daily_schedules[0].clock_in_status, 'missed_window');
    assert.equal(scheduler.getDiagnosticsSnapshot().clockIn.cronRegistered, false);
  }
  assert.equal(clockCalls.length, 0);
});
