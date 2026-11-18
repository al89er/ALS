const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// Isolate local cache and settings inside OS temp dir so tests never touch repo/AppData state
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'als-adv-sched-test-'));
process.env.ALS_CACHE_FILE = path.join(tempDir, 'local_cache.json');
process.env.ALS_SETTINGS_FILE = path.join(tempDir, 'settings.json');
process.env.ALS_EDITION = 'full';

// Guard against any real network call escaping test mocks
global.fetch = async (url) => {
  throw new Error(`REAL_NETWORK_BLOCKED_IN_TEST: Attempted fetch to ${url}`);
};

// --- Stateful In-Memory Supabase Mock ---
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
        '0': { mode: 'full_skip', label: 'Weekend Default' },
        '1': { mode: 'normal', label: 'Working Day' },
        '2': { mode: 'normal', label: 'Working Day' },
        '3': { mode: 'normal', label: 'Working Day' },
        '4': { mode: 'normal', label: 'Working Day' },
        '5': { mode: 'normal', label: 'Working Day' },
        '6': { mode: 'full_skip', label: 'Weekend Default' }
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
  let schemaMissing = false;
  const listeners = [];

  function clone(v) {
    return JSON.parse(JSON.stringify(v));
  }

  function applyFilters(rows, filters) {
    return rows.filter((row) => {
      for (const f of filters) {
        if (f.type === 'eq' && row[f.col] !== f.val) return false;
        if (f.type === 'gte' && !(row[f.col] >= f.val)) return false;
        if (f.type === 'lte' && !(row[f.col] <= f.val)) return false;
        if (f.type === 'in' && !f.vals.includes(row[f.col])) return false;
        if (f.type === 'or') {
          const parts = f.expr.split(',').map((s) => s.trim());
          const matched = parts.some((p) => {
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
          if (!matched) return false;
        }
      }
      return true;
    });
  }

  function bumpRevision() {
    if (db.schedule_policy_state[0]) {
      db.schedule_policy_state[0].revision = (Number(db.schedule_policy_state[0].revision) || 1) + 1;
      db.schedule_policy_state[0].policy_updated_at = new Date().toISOString();
      return db.schedule_policy_state[0].revision;
    }
    return 1;
  }

  function upsertRow(table, payload) {
    const rows = db[table];
    if (!rows) return payload;
    let idx = -1;
    if (table === 'daily_schedules' || table === 'todays_proof') {
      idx = rows.findIndex((r) => r.date === payload.date && (r.device_id || 'home_desktop_agent') === (payload.device_id || 'home_desktop_agent'));
    } else if (table === 'schedule_date_overrides') {
      idx = rows.findIndex((r) => r.date === payload.date && r.device_id === payload.device_id);
    } else if (table === 'schedule_policy_state' || table === 'system_config' || table === 'device_status') {
      idx = rows.findIndex((r) => (r.device_id || r.id) === (payload.device_id || payload.id));
    } else if (table === 'skip_days') {
      idx = rows.findIndex((r) => r.date === payload.date && (r.device_id || 'home_desktop_agent') === (payload.device_id || 'home_desktop_agent'));
    } else if (table === 'schedule_holidays') {
      idx = rows.findIndex((r) => (payload.id && r.id === payload.id) || (r.date === payload.date && r.device_id === payload.device_id));
    } else if (payload.id) {
      idx = rows.findIndex((r) => r.id === payload.id);
    }

    const stored = { ...payload };
    if (!stored.id && (table === 'schedule_date_overrides' || table === 'schedule_recurring_rules' || table === 'schedule_holidays' || table === 'logs')) {
      stored.id = `${table}_${rows.length + 1}_${Date.now()}`;
    }

    if (idx >= 0) {
      rows[idx] = { ...rows[idx], ...stored };
      return rows[idx];
    }
    rows.push(stored);
    return stored;
  }

  function createQueryBuilder(table) {
    const state = {
      op: 'select',
      cols: '*',
      filters: [],
      orders: [],
      limitCount: null,
      singleMode: null,
      payload: null
    };

    const builder = {
      select(cols = '*') {
        state.cols = cols;
        return builder;
      },
      insert(payload) {
        state.op = 'insert';
        state.payload = payload;
        return builder;
      },
      upsert(payload) {
        state.op = 'upsert';
        state.payload = payload;
        return builder;
      },
      update(payload) {
        state.op = 'update';
        state.payload = payload;
        return builder;
      },
      delete() {
        state.op = 'delete';
        return builder;
      },
      eq(col, val) {
        state.filters.push({ type: 'eq', col, val });
        return builder;
      },
      gte(col, val) {
        state.filters.push({ type: 'gte', col, val });
        return builder;
      },
      lte(col, val) {
        state.filters.push({ type: 'lte', col, val });
        return builder;
      },
      in(col, vals) {
        state.filters.push({ type: 'in', col, vals });
        return builder;
      },
      or(expr) {
        state.filters.push({ type: 'or', expr });
        return builder;
      },
      order(col, opts = {}) {
        state.orders.push({ col, ascending: opts.ascending !== false });
        return builder;
      },
      limit(n) {
        state.limitCount = n;
        return builder;
      },
      maybeSingle() {
        state.singleMode = 'maybeSingle';
        return builder;
      },
      single() {
        state.singleMode = 'single';
        return builder;
      },
      async _execute() {
        if (offlineError) {
          return { data: null, error: { message: offlineError } };
        }
        if (
          schemaMissing &&
          (table === 'schedule_policy_state' ||
            table === 'schedule_date_overrides' ||
            table === 'schedule_recurring_rules' ||
            table === 'schedule_holidays')
        ) {
          return { data: null, error: { code: '42P01', message: `relation "${table}" does not exist` } };
        }

        const tableRows = db[table];
        if (!tableRows) {
          return { data: null, error: { message: `Unknown table ${table}` } };
        }

        if (state.op === 'select') {
          let result = applyFilters(tableRows, state.filters);
          for (const ord of state.orders) {
            result = [...result].sort((a, b) => {
              const av = a[ord.col];
              const bv = b[ord.col];
              if (av === bv) return 0;
              return (av < bv ? -1 : 1) * (ord.ascending ? 1 : -1);
            });
          }
          if (state.limitCount !== null) {
            result = result.slice(0, state.limitCount);
          }
          const cloned = clone(result);
          if (state.singleMode === 'maybeSingle') {
            return { data: cloned[0] || null, error: null };
          }
          if (state.singleMode === 'single') {
            return cloned[0]
              ? { data: cloned[0], error: null }
              : { data: null, error: { code: 'PGRST116', message: 'Not found' } };
          }
          return { data: cloned, error: null };
        }

        if (state.op === 'insert') {
          const items = Array.isArray(state.payload) ? state.payload : [state.payload];
          const inserted = items.map((item) => upsertRow(table, item));
          if (['schedule_date_overrides', 'schedule_recurring_rules', 'schedule_holidays', 'skip_days'].includes(table)) {
            bumpRevision();
          }
          const out = clone(inserted);
          return { data: state.singleMode ? out[0] : out, error: null };
        }

        if (state.op === 'upsert') {
          const items = Array.isArray(state.payload) ? state.payload : [state.payload];
          const saved = items.map((item) => upsertRow(table, item));
          if (['schedule_date_overrides', 'schedule_recurring_rules', 'schedule_holidays', 'skip_days'].includes(table)) {
            bumpRevision();
          }
          const out = clone(saved);
          return { data: state.singleMode ? out[0] : out, error: null };
        }

        if (state.op === 'update') {
          const matched = applyFilters(tableRows, state.filters);
          for (const row of matched) {
            Object.assign(row, state.payload);
          }
          if (['schedule_date_overrides', 'schedule_recurring_rules', 'schedule_holidays', 'skip_days'].includes(table)) {
            bumpRevision();
          }
          const out = clone(matched);
          return { data: state.singleMode ? (out[0] || null) : out, error: null };
        }

        if (state.op === 'delete') {
          const matched = applyFilters(tableRows, state.filters);
          db[table] = tableRows.filter((r) => !matched.includes(r));
          if (['schedule_date_overrides', 'schedule_recurring_rules', 'schedule_holidays', 'skip_days'].includes(table)) {
            bumpRevision();
          }
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

  const client = {
    db,
    setOffline(msg) {
      offlineError = msg;
    },
    setSchemaMissing(flag) {
      schemaMissing = flag;
    },
    bumpRevision,
    from(table) {
      return createQueryBuilder(table);
    },
    auth: {
      async signInWithPassword() {
        return { data: { session: { access_token: 'mock-jwt' } }, error: null };
      },
      async getSession() {
        return { data: { session: { access_token: 'mock-jwt' } }, error: null };
      },
      onAuthStateChange() {
        return { data: { subscription: { unsubscribe() {} } } };
      }
    },
    realtime: {
      setAuth() {}
    },
    channel(name) {
      const ch = {
        name,
        state: 'joined',
        handlers: [],
        on(type, filter, cb) {
          if (type === 'postgres_changes') {
            listeners.push({ channel: ch, filter, cb });
          }
          return ch;
        },
        subscribe(cb) {
          ch.state = 'joined';
          if (typeof cb === 'function') cb('SUBSCRIBED');
          return ch;
        }
      };
      return ch;
    },
    removeChannel() {},
    emitPostgresChange(table, eventType, newRow, oldRow = {}) {
      for (const l of listeners) {
        if (l.filter && l.filter.table === table) {
          l.cb({ eventType, table, new: clone(newRow), old: clone(oldRow) });
        }
      }
    },
    async rpc() {
      return { data: { ok: true }, error: null };
    }
  };

  return client;
}

const mockSupabase = createMockSupabase();

// Inject @supabase/supabase-js mock before requiring supabase-client/scheduler
const supabasePkgPath = require.resolve('@supabase/supabase-js', {
  paths: [path.join(__dirname, '..')]
});
require.cache[supabasePkgPath] = {
  id: supabasePkgPath,
  filename: supabasePkgPath,
  loaded: true,
  exports: {
    createClient: () => mockSupabase
  }
};

const cacheManager = require('../cache-manager');
const automation = require('../automation');
const scheduler = require('../scheduler');
const supabaseClient = require('../supabase-client');
const moduleLoader = require('../module-loader');

// Helper: create a future HH:MM time safely on the SAME local calendar date
function getSameDayTimeOffset(minutesOffset) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 0, 0);
  let target = new Date(now.getTime() + minutesOffset * 60000);
  if (target > todayEnd) target = todayEnd;
  if (target < todayStart) target = todayStart;
  const hh = String(target.getHours()).padStart(2, '0');
  const mm = String(target.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function getTodayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function resetAllState() {
  scheduler.__test.stopCronJobs();
  scheduler.__test.resetRuntimeDependencies();
  scheduler.__test.resetSchedulerStateForTest();

  mockSupabase.setOffline(null);
  mockSupabase.setSchemaMissing(false);
  mockSupabase.db.schedule_date_overrides = [];
  mockSupabase.db.schedule_recurring_rules = [];
  mockSupabase.db.schedule_holidays = [];
  mockSupabase.db.skip_days = [];
  mockSupabase.db.daily_schedules = [];
  mockSupabase.db.todays_proof = [];
  mockSupabase.db.device_status = [];
  mockSupabase.db.commands = [];
  mockSupabase.db.logs = [];
  mockSupabase.db.system_config = [{
    device_id: 'home_desktop_agent',
    auto_clock_enabled: true,
    clock_in_base_time: getSameDayTimeOffset(30),
    clock_out_base_time: getSameDayTimeOffset(120),
    random_period_minutes: 0
  }];
  mockSupabase.db.schedule_policy_state = [{
    device_id: 'home_desktop_agent',
    revision: 1,
    applied_revision: 0,
    ack_status: 'pending',
    ack_message: null,
    weekly_defaults: {
      '0': 'normal',
      '1': 'normal',
      '2': 'normal',
      '3': 'normal',
      '4': 'normal',
      '5': 'normal',
      '6': 'normal'
    },
    policy_updated_at: new Date().toISOString()
  }];

  process.env.ALS_EDITION = 'full';
  cacheManager.saveDeviceConfig({
    device_id: 'home_desktop_agent',
    device_name: 'Home Desktop',
    edition: 'full',
    auto_clock_enabled: true,
    clock_in_base_time: getSameDayTimeOffset(30),
    clock_out_base_time: getSameDayTimeOffset(120),
    random_period_minutes: 0
  });
  cacheManager.writeCache({
    last_synced: null,
    daily_schedule: null,
    system_config: { ...mockSupabase.db.system_config[0] },
    skip_days: [],
    schedule_policy: {
      revision: 0,
      weekly_defaults: { ...mockSupabase.db.schedule_policy_state[0].weekly_defaults },
      date_overrides: {},
      recurring_rules: [],
      holidays: {}
    },
    todays_proof: null,
    offline_proofs: [],
    offline_logs: []
  });
  global.connectivityState = 'Connected to Supabase';
}

function createFakeCronHarness() {
  const registered = [];
  const cronSchedule = (expr, cb) => {
    const task = {
      expr,
      cb,
      stopped: false,
      stop() {
        task.stopped = true;
      }
    };
    registered.push(task);
    return task;
  };
  return { registered, cronSchedule };
}

test.after(() => {
  scheduler.__test.stopCronJobs();
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (_) {}
});

test('1. CRITICAL REGRESSION: morning clock-in done + switching today to clock_in_only immediately cancels pending clock-out & blocks stale cron firing', async () => {
  resetAllState();
  const todayStr = getTodayStr();
  const morningTime = getSameDayTimeOffset(-90);
  const afternoonTime = getSameDayTimeOffset(120);

  // If running near midnight (< 01:30 AM) ensure morningTime is safely <= now and afternoonTime > morningTime
  mockSupabase.db.system_config[0].clock_in_base_time = morningTime;
  mockSupabase.db.system_config[0].clock_out_base_time = afternoonTime;
  mockSupabase.db.daily_schedules = [{
    date: todayStr,
    device_id: 'home_desktop_agent',
    skipped: false,
    effective_mode: 'normal',
    scheduled_clock_in: morningTime,
    scheduled_clock_out: afternoonTime,
    planned_clock_in: morningTime,
    planned_clock_out: afternoonTime,
    clock_in_done: true,
    clock_out_done: false,
    clock_in_status: 'done',
    clock_out_status: 'pending'
  }];
  mockSupabase.db.todays_proof = [{
    date: todayStr,
    device_id: 'home_desktop_agent',
    clock_in: '07:48:15',
    clock_out: null,
    image_url: 'https://proof.test/morning.png'
  }];
  cacheManager.updateCache('todays_proof', { ...mockSupabase.db.todays_proof[0] });

  const clockCalls = [];
  const harness = createFakeCronHarness();
  scheduler.__test.setRuntimeDependenciesForTest({
    cronSchedule: harness.cronSchedule,
    executeClockAction: async (actionType) => {
      clockCalls.push(actionType);
      return { success: true };
    }
  });

  // Step 1-3: Initial startup reconciliation arms pending clock-out cron job
  await scheduler.reconcileSchedule(mockSupabase, { triggerSource: 'startup', force: true });
  const snapBefore = scheduler.getRuntimeSnapshot();
  assert.equal(snapBefore.clockInScheduled, false, 'morning clock-in is already done');
  assert.equal(snapBefore.clockOutScheduled, true, 'afternoon clock-out job must be armed');
  assert.equal(snapBefore.currentAppliedRevision, 1);

  const armedClockOutTask = harness.registered.find((t) => !t.stopped && t.expr !== '0 0 * * *');
  assert.ok(armedClockOutTask, 'clockOut cron task object should exist');

  // Step 4-5: User sets today to clock_in_only -> Realtime delivers override & rev #2
  mockSupabase.db.schedule_date_overrides.push({
    id: 'ov_1',
    device_id: 'home_desktop_agent',
    date: todayStr,
    mode: 'clock_in_only',
    reason: 'Official outstation duty'
  });
  mockSupabase.db.schedule_policy_state[0].revision = 2;

  await supabaseClient.__test.handleScheduleRealtimeEvent('schedule_policy_state', {
    eventType: 'UPDATE',
    new: { device_id: 'home_desktop_agent', revision: 2, applied_revision: 1 }
  });

  // Step 6: Verify immediate cancellation + acknowledgement
  assert.equal(armedClockOutTask.stopped, true, 'pending clockOutTask must be stopped immediately');
  const snapAfter = scheduler.getRuntimeSnapshot();
  assert.equal(snapAfter.clockOutScheduled, false);
  assert.equal(snapAfter.currentAppliedRevision, 2);

  const ackRow = mockSupabase.db.schedule_policy_state[0];
  assert.equal(ackRow.applied_revision, 2);
  assert.equal(ackRow.ack_status, 'applied');
  assert.equal(ackRow.effective_today_mode, 'clock_in_only');
  assert.equal(ackRow.effective_clock_out_status, 'cancelled');

  // Step 7-8: Even if the captured cron callback somehow triggers, gate blocks it!
  await armedClockOutTask.cb();
  assert.equal(clockCalls.length, 0, 'cancelled clock-out MUST NOT execute');

  // Step 9-10: Completed morning clock-in and proof are untouched
  const schedRow = mockSupabase.db.daily_schedules[0];
  assert.equal(schedRow.clock_in_done, true);
  assert.equal(schedRow.clock_out_done, false);
  assert.equal(schedRow.clock_out_status, 'cancelled');
  assert.equal(mockSupabase.db.todays_proof[0].clock_in, '07:48:15');
  assert.equal(mockSupabase.db.todays_proof[0].image_url, 'https://proof.test/morning.png');
});

test('2. Day modes: full_skip before action, full_skip after clock-in, clock_out_only, and restoring normal', async () => {
  resetAllState();
  const todayStr = getTodayStr();
  const tIn = getSameDayTimeOffset(40);
  const tOut = getSameDayTimeOffset(90);
  mockSupabase.db.system_config[0].clock_in_base_time = tIn;
  mockSupabase.db.system_config[0].clock_out_base_time = tOut;
  cacheManager.saveDeviceConfig({
    device_id: 'home_desktop_agent',
    device_name: 'Home Desktop',
    edition: 'full',
    auto_clock_enabled: true,
    clock_in_base_time: tIn,
    clock_out_base_time: tOut,
    random_period_minutes: 0
  });

  const harness = createFakeCronHarness();
  scheduler.__test.setRuntimeDependenciesForTest({ cronSchedule: harness.cronSchedule });

  await scheduler.reconcileSchedule(mockSupabase, { triggerSource: 'startup', force: true });
  assert.equal(scheduler.getRuntimeSnapshot().clockInScheduled, true);
  assert.equal(scheduler.getRuntimeSnapshot().clockOutScheduled, true);

  // Full skip before any action
  mockSupabase.db.schedule_date_overrides = [{ device_id: 'home_desktop_agent', date: todayStr, mode: 'full_skip' }];
  mockSupabase.db.schedule_policy_state[0].revision = 2;
  await scheduler.reconcileSchedule(mockSupabase, { triggerSource: 'realtime:schedule_date_overrides', eventRevision: 2, force: true });
  assert.equal(scheduler.getRuntimeSnapshot().clockInScheduled, false);
  assert.equal(scheduler.getRuntimeSnapshot().clockOutScheduled, false);
  assert.equal(mockSupabase.db.daily_schedules[0].skipped, true);

  // Switch to clock_out_only while both planned times are still in future
  mockSupabase.db.schedule_date_overrides = [{ device_id: 'home_desktop_agent', date: todayStr, mode: 'clock_out_only' }];
  mockSupabase.db.schedule_policy_state[0].revision = 3;
  await scheduler.reconcileSchedule(mockSupabase, { triggerSource: 'realtime', eventRevision: 3, force: true });
  assert.equal(scheduler.getRuntimeSnapshot().clockInScheduled, false);
  assert.equal(scheduler.getRuntimeSnapshot().clockOutScheduled, true);

  // Restore to normal -> both future jobs armed again
  mockSupabase.db.schedule_date_overrides = [{ device_id: 'home_desktop_agent', date: todayStr, mode: 'normal' }];
  mockSupabase.db.schedule_policy_state[0].revision = 4;
  await scheduler.reconcileSchedule(mockSupabase, { triggerSource: 'realtime', eventRevision: 4, force: true });
  assert.equal(scheduler.getRuntimeSnapshot().clockInScheduled, true);
  assert.equal(scheduler.getRuntimeSnapshot().clockOutScheduled, true);

  // Now simulate morning clock-in done, then apply full_skip -> preserves clock_in_done
  mockSupabase.db.daily_schedules[0].clock_in_done = true;
  mockSupabase.db.daily_schedules[0].clock_in_status = 'done';
  mockSupabase.db.schedule_date_overrides = [{ device_id: 'home_desktop_agent', date: todayStr, mode: 'full_skip' }];
  mockSupabase.db.schedule_policy_state[0].revision = 5;
  await scheduler.reconcileSchedule(mockSupabase, { triggerSource: 'realtime', eventRevision: 5, force: true });
  assert.equal(mockSupabase.db.daily_schedules[0].clock_in_done, true);
  assert.equal(mockSupabase.db.daily_schedules[0].clock_in_status, 'completed');
  assert.equal(mockSupabase.db.daily_schedules[0].clock_out_status, 'cancelled');
  assert.equal(scheduler.getRuntimeSnapshot().clockOutScheduled, false);
});

test('3. Pre-flight abort (ACTION_CANCELLED_BY_POLICY) and active click warning_in_progress handling', async () => {
  resetAllState();
  const todayStr = getTodayStr();
  const tOut = getSameDayTimeOffset(60);
  mockSupabase.db.system_config[0].clock_in_base_time = getSameDayTimeOffset(30);
  mockSupabase.db.system_config[0].clock_out_base_time = tOut;

  // Part A: waitUntilTarget aborts cleanly when shouldAbort turns true
  let aborted = false;
  const fakePage = {
    waitForTimeout: (ms) => new Promise((r) => setTimeout(r, ms))
  };
  setTimeout(() => { aborted = true; }, 25);
  await assert.rejects(
    automation.__test.waitUntilTarget(fakePage, new Date(Date.now() + 120), 120000, () => aborted),
    (err) => err && err.message === 'ACTION_CANCELLED_BY_POLICY'
  );

  // Part B: executeGatedScheduledAction aborts mid-wait without completing clock action
  const harness = createFakeCronHarness();
  let clickExecuted = false;
  let releaseWait;
  const waitEntered = new Promise((res) => { releaseWait = res; });

  scheduler.__test.setRuntimeDependenciesForTest({
    cronSchedule: harness.cronSchedule,
    executeClockAction: async (actionType, _sb, opts) => {
      releaseWait();
      for (let i = 0; i < 20; i++) {
        if (opts.shouldAbort && opts.shouldAbort()) {
          throw new Error('ACTION_CANCELLED_BY_POLICY');
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      if (opts.onActiveClickStart) opts.onActiveClickStart();
      clickExecuted = true;
      return { success: true };
    }
  });

  await scheduler.reconcileSchedule(mockSupabase, { triggerSource: 'startup', force: true });
  const rev = scheduler.getRuntimeSnapshot().currentAppliedRevision;

  const execPromise = scheduler.__test.executeGatedScheduledAction('clock_out', {
    boundRevision: rev,
    boundJobId: scheduler.getRuntimeSnapshot().clockOutJobId,
    dateString: todayStr,
    plannedTime: tOut,
    source: 'cron'
  }, mockSupabase);

  await waitEntered;
  mockSupabase.db.schedule_date_overrides = [{ device_id: 'home_desktop_agent', date: todayStr, mode: 'full_skip' }];
  mockSupabase.db.schedule_policy_state[0].revision = rev + 1;
  await scheduler.reconcileSchedule(mockSupabase, { triggerSource: 'realtime', eventRevision: rev + 1, force: true });

  const res = await execPromise;
  assert.equal(res.executed, false);
  assert.equal(clickExecuted, false, 'should abort before clicking');

  // Part C: active_clicking stage produces honest warning_in_progress ack
  mockSupabase.db.schedule_date_overrides = [{ device_id: 'home_desktop_agent', date: todayStr, mode: 'normal' }];
  mockSupabase.db.schedule_policy_state[0].revision = rev + 2;
  await scheduler.reconcileSchedule(mockSupabase, { triggerSource: 'realtime', eventRevision: rev + 2, force: true });

  const state = scheduler.__test.getSchedulerState();
  state.inFlightExecution = {
    actionType: 'clock_out',
    date: todayStr,
    jobId: 99,
    boundRevision: rev + 2,
    stage: 'active_clicking',
    aborted: false
  };
  mockSupabase.db.schedule_date_overrides = [{ device_id: 'home_desktop_agent', date: todayStr, mode: 'clock_in_only' }];
  mockSupabase.db.schedule_policy_state[0].revision = rev + 3;
  await scheduler.reconcileSchedule(mockSupabase, { triggerSource: 'realtime', eventRevision: rev + 3, force: true });

  assert.equal(mockSupabase.db.schedule_policy_state[0].ack_status, 'warning_in_progress');
  state.inFlightExecution = null;
});

test('4. Re-enabling an action whose planned time already passed marks missed and NEVER auto-executes catch-up', async () => {
  resetAllState();
  const todayStr = getTodayStr();
  // Create a planned time in the past (00:01 AM today is safely past as long as not literally 00:00-00:01, fallback check included)
  const pastTime = new Date().getHours() === 0 && new Date().getMinutes() < 2 ? '00:00' : '00:01';
  const futureOut = getSameDayTimeOffset(120);

  mockSupabase.db.system_config[0].clock_in_base_time = pastTime;
  mockSupabase.db.system_config[0].clock_out_base_time = futureOut;
  mockSupabase.db.schedule_date_overrides = [{ device_id: 'home_desktop_agent', date: todayStr, mode: 'full_skip' }];
  mockSupabase.db.daily_schedules = [{
    date: todayStr,
    device_id: 'home_desktop_agent',
    skipped: true,
    effective_mode: 'full_skip',
    planned_clock_in: pastTime,
    planned_clock_out: futureOut,
    clock_in_done: false,
    clock_out_done: false,
    clock_in_status: 'cancelled',
    clock_out_status: 'cancelled'
  }];

  const clockCalls = [];
  const harness = createFakeCronHarness();
  scheduler.__test.setRuntimeDependenciesForTest({
    cronSchedule: harness.cronSchedule,
    executeClockAction: async (actionType) => {
      clockCalls.push(actionType);
      return { success: true };
    }
  });

  await scheduler.reconcileSchedule(mockSupabase, { triggerSource: 'startup', force: true });
  assert.equal(scheduler.getRuntimeSnapshot().clockInScheduled, false);

  // Switch back to normal after planned_clock_in already passed
  mockSupabase.db.schedule_date_overrides = [{ device_id: 'home_desktop_agent', date: todayStr, mode: 'normal' }];
  mockSupabase.db.schedule_policy_state[0].revision = 2;
  await scheduler.reconcileSchedule(mockSupabase, { triggerSource: 'realtime', eventRevision: 2, force: true });

  if (pastTime !== '00:00' || new Date().getMinutes() > 0) {
    assert.equal(mockSupabase.db.daily_schedules[0].clock_in_status, 'missed_window');
    assert.equal(scheduler.getRuntimeSnapshot().clockInScheduled, false, 'expired clock-in must not be armed');
  }
  assert.equal(clockCalls.length, 0, 'expired action must never trigger silent catch-up');
});

test('5. Rapid policy changes, duplicate Realtime events, and stale/out-of-order revision suppression', async () => {
  resetAllState();
  const todayStr = getTodayStr();
  const harness = createFakeCronHarness();
  scheduler.__test.setRuntimeDependenciesForTest({ cronSchedule: harness.cronSchedule });

  mockSupabase.db.schedule_policy_state[0].revision = 4;
  mockSupabase.db.schedule_date_overrides = [{ device_id: 'home_desktop_agent', date: todayStr, mode: 'clock_in_only' }];

  // Apply rev 4
  await scheduler.reconcileSchedule(mockSupabase, { triggerSource: 'realtime', eventRevision: 4, force: true });
  assert.equal(scheduler.getRuntimeSnapshot().currentAppliedRevision, 4);

  // Out-of-order stale rev 2 (force: false)
  const staleRes = await scheduler.reconcileSchedule(mockSupabase, { triggerSource: 'realtime_late', eventRevision: 2, force: false });
  assert.equal(staleRes.ignoredStale, true);
  assert.equal(scheduler.getRuntimeSnapshot().currentAppliedRevision, 4);

  // Duplicate Realtime self-ack payload at same rev 4
  const dupRes = await supabaseClient.__test.handleScheduleRealtimeEvent('schedule_policy_state', {
    eventType: 'UPDATE',
    new: { device_id: 'home_desktop_agent', revision: 4, applied_revision: 4 }
  });
  assert.equal(dupRes, null, 'duplicate already-applied revision must be ignored cleanly');

  // Rapid concurrent rev 5 & rev 6 changes resolve serialized to rev 6
  mockSupabase.db.schedule_policy_state[0].revision = 6;
  mockSupabase.db.schedule_date_overrides = [{ device_id: 'home_desktop_agent', date: todayStr, mode: 'full_skip' }];
  await Promise.all([
    scheduler.reconcileSchedule(mockSupabase, { triggerSource: 'rapid_1', eventRevision: 5, force: true }),
    scheduler.reconcileSchedule(mockSupabase, { triggerSource: 'rapid_2', eventRevision: 6, force: true })
  ]);

  assert.equal(scheduler.getRuntimeSnapshot().currentAppliedRevision, 6);
  assert.equal(mockSupabase.db.schedule_policy_state[0].effective_today_mode, 'full_skip');
});

test('6. Offline Supabase outage during calendar edits & automatic reconnect reconciliation', async () => {
  resetAllState();
  const todayStr = getTodayStr();
  const harness = createFakeCronHarness();
  scheduler.__test.setRuntimeDependenciesForTest({ cronSchedule: harness.cronSchedule });

  await scheduler.reconcileSchedule(mockSupabase, { triggerSource: 'startup', force: true });
  assert.equal(scheduler.getRuntimeSnapshot().clockOutScheduled, true);

  // Simulate network drop -> heartbeat marks Offline
  mockSupabase.setOffline('FetchError: ECONNREFUSED');
  const hbFail = await supabaseClient.__test.pingHeartbeatOnce();
  assert.equal(hbFail.online, false);
  assert.equal(global.connectivityState, 'Offline');

  // While desktop was offline, web dashboard bumped Supabase to full_skip (rev #7)
  mockSupabase.db.schedule_date_overrides = [{ device_id: 'home_desktop_agent', date: todayStr, mode: 'full_skip' }];
  mockSupabase.db.schedule_policy_state[0].revision = 7;

  // Network returns -> heartbeat recovers, detects wasOffline=true, reconciles rev #7!
  mockSupabase.setOffline(null);
  const hbRecover = await supabaseClient.__test.pingHeartbeatOnce();
  assert.equal(hbRecover.online, true);
  assert.equal(hbRecover.wasOffline, true);

  const snap = scheduler.getRuntimeSnapshot();
  assert.equal(snap.currentAppliedRevision, 7);
  assert.equal(snap.clockInScheduled, false);
  assert.equal(snap.clockOutScheduled, false);
  assert.equal(mockSupabase.db.schedule_policy_state[0].applied_revision, 7);
});

test('7. App restart restoration, sleep/resume reconciliation, and midnight rollover cron', async () => {
  resetAllState();
  const todayStr = getTodayStr();
  const harness = createFakeCronHarness();
  scheduler.__test.setRuntimeDependenciesForTest({ cronSchedule: harness.cronSchedule });

  mockSupabase.db.daily_schedules = [{
    date: todayStr,
    device_id: 'home_desktop_agent',
    skipped: false,
    effective_mode: 'normal',
    planned_clock_in: getSameDayTimeOffset(-60),
    planned_clock_out: getSameDayTimeOffset(90),
    scheduled_clock_in: getSameDayTimeOffset(-60),
    scheduled_clock_out: getSameDayTimeOffset(90),
    clock_in_done: true,
    clock_out_done: false,
    clock_in_status: 'done',
    clock_out_status: 'pending'
  }];

  await scheduler.init(mockSupabase);
  assert.equal(scheduler.getRuntimeSnapshot().clockInScheduled, false);
  assert.equal(scheduler.getRuntimeSnapshot().clockOutScheduled, true);

  const midnightTask = harness.registered.find((t) => t.expr === '0 0 * * *');
  assert.ok(midnightTask, 'midnight rollover cron must be registered on init');

  // Simulate restart (reset in-memory scheduler state while preserving DB + local cache)
  scheduler.__test.stopCronJobs();
  scheduler.__test.resetSchedulerStateForTest();
  await scheduler.init(mockSupabase);
  assert.equal(scheduler.getRuntimeSnapshot().clockOutScheduled, true);
  assert.equal(mockSupabase.db.daily_schedules[0].clock_in_done, true);

  // Simulate OS power resume after policy change
  mockSupabase.db.schedule_date_overrides = [{ device_id: 'home_desktop_agent', date: todayStr, mode: 'clock_in_only' }];
  mockSupabase.db.schedule_policy_state[0].revision = 9;
  await scheduler.reconcileSchedule(mockSupabase, { triggerSource: 'os_power_resume', force: true });
  assert.equal(scheduler.getRuntimeSnapshot().clockOutScheduled, false);
  assert.equal(mockSupabase.db.schedule_policy_state[0].applied_revision, 9);

  // Simulate midnight rollover cron execution
  mockSupabase.db.schedule_date_overrides = [];
  mockSupabase.db.schedule_policy_state[0].revision = 10;
  await midnightTask.cb();
  assert.equal(scheduler.getRuntimeSnapshot().currentAppliedRevision, 10);
});

test('8. Configurable working days & Saturday manual/weekly override (no hardcoded weekend block)', () => {
  // 2026-11-21 is Saturday
  const satPolicy = {
    weekly_defaults: {
      '0': 'full_skip',
      '6': 'normal'
    },
    date_overrides: {},
    recurring_rules: [],
    holidays: {},
    skip_days: []
  };

  const satEval = scheduler.evaluateDatePolicy('2026-11-21', satPolicy);
  assert.equal(satEval.effectiveMode, 'normal');
  assert.equal(satEval.clockInEnabled, true);
  assert.equal(satEval.clockOutEnabled, true);
  assert.equal(satEval.ruleSource, 'weekly_default');

  // Sunday default is full_skip, but manual override enables clock_in_only on Sunday 2026-11-22
  const sunManual = scheduler.evaluateDatePolicy('2026-11-22', {
    ...satPolicy,
    date_overrides: {
      '2026-11-22': { date: '2026-11-22', mode: 'clock_in_only', reason: 'Event setup' }
    }
  });
  assert.equal(sunManual.effectiveMode, 'clock_in_only');
  assert.equal(sunManual.clockInEnabled, true);
  assert.equal(sunManual.clockOutEnabled, false);
  assert.equal(sunManual.ruleSource, 'manual_override');
});

test('9. Recurring rules (weekly, monthly_nth_weekday, monthly_day) & full precedence hierarchy', () => {
  // 2026-11-13 is Friday; 2026-11-27 is the last (-1) Friday of Nov 2026; 2026-11-15 is 15th
  const rules = [
    {
      id: 'r_weekly',
      name: 'Friday Half Day',
      recurrence_type: 'weekly',
      day_of_week: 5,
      mode: 'clock_in_only',
      priority: 100,
      enabled: true,
      effective_from: '2026-11-01',
      effective_to: '2026-11-30'
    },
    {
      id: 'r_nth',
      name: 'Last Friday Full Skip',
      recurrence_type: 'monthly_nth_weekday',
      nth_week: -1,
      day_of_week: 5,
      mode: 'full_skip',
      priority: 50,
      enabled: true
    },
    {
      id: 'r_mday',
      name: '15th Clock Out Only',
      recurrence_type: 'monthly_day',
      day_of_month: 15,
      mode: 'clock_out_only',
      priority: 10,
      enabled: true
    }
  ];

  assert.equal(scheduler.matchesRecurringRule('2026-11-13', rules[0]), true);
  assert.equal(scheduler.matchesRecurringRule('2026-12-04', rules[0]), false, 'outside effective_to');
  assert.equal(scheduler.matchesRecurringRule('2026-11-27', rules[1]), true, 'last Friday match');
  assert.equal(scheduler.matchesRecurringRule('2026-11-20', rules[1]), false);
  assert.equal(scheduler.matchesRecurringRule('2026-11-15', rules[2]), true);

  // Precedence test on 2026-11-27 (Friday: weekly=clock_in_only priority 100 vs nth=full_skip priority 50)
  const weeklyDefaults = { '5': 'clock_out_only' };

  // Layer 1: system_default
  assert.equal(scheduler.evaluateDatePolicy('2026-11-27', {}).ruleSource, 'system_default');

  // Layer 2: weekly_default beats system_default
  assert.equal(
    scheduler.evaluateDatePolicy('2026-11-27', { weekly_defaults: weeklyDefaults }).ruleSource,
    'weekly_default'
  );

  // Layer 3: recurring_rule beats weekly_default; higher priority rule wins deterministically
  const recEval = scheduler.evaluateDatePolicy('2026-11-27', {
    weekly_defaults: weeklyDefaults,
    recurring_rules: rules
  });
  assert.equal(recEval.ruleSource, 'recurring_rule');
  assert.equal(recEval.effectiveMode, 'clock_in_only');
  assert.equal(recEval.matchedRulesCount, 2);

  // Layer 4: legacy_skip_day beats recurring_rule
  const legacyEval = scheduler.evaluateDatePolicy('2026-11-27', {
    weekly_defaults: weeklyDefaults,
    recurring_rules: rules,
    skip_days: ['2026-11-27']
  });
  assert.equal(legacyEval.ruleSource, 'legacy_skip_day');
  assert.equal(legacyEval.effectiveMode, 'full_skip');

  // Layer 5: approved_holiday beats legacy_skip_day
  const holEval = scheduler.evaluateDatePolicy('2026-11-27', {
    weekly_defaults: weeklyDefaults,
    recurring_rules: rules,
    skip_days: ['2026-11-27'],
    holidays: {
      '2026-11-27': { date: '2026-11-27', name: 'Special Holiday', mode: 'clock_out_only', approved: true }
    }
  });
  assert.equal(holEval.ruleSource, 'approved_holiday');
  assert.equal(holEval.effectiveMode, 'clock_out_only');

  // Layer 6: manual_override beats approved_holiday
  const manEval = scheduler.evaluateDatePolicy('2026-11-27', {
    weekly_defaults: weeklyDefaults,
    recurring_rules: rules,
    skip_days: ['2026-11-27'],
    holidays: {
      '2026-11-27': { date: '2026-11-27', name: 'Special Holiday', mode: 'clock_out_only', approved: true }
    },
    date_overrides: {
      '2026-11-27': { date: '2026-11-27', mode: 'normal', reason: 'Manual Duty' }
    }
  });
  assert.equal(manEval.ruleSource, 'manual_override');
  assert.equal(manEval.effectiveMode, 'normal');
});

test('10. Bulk selection modes & Malaysian Public Holidays suggested vs approved semantics', () => {
  assert.deepEqual(
    scheduler.expandBulkDates({ mode: 'multiple', dates: ['2026-11-12', '2026-11-10', '2026-11-12'] }),
    ['2026-11-10', '2026-11-12']
  );

  // 2026-11-20 Fri .. 2026-11-23 Mon
  assert.deepEqual(
    scheduler.expandBulkDates({ mode: 'range_all', startDate: '2026-11-20', endDate: '2026-11-23' }),
    ['2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23']
  );
  assert.deepEqual(
    scheduler.expandBulkDates({ mode: 'range_weekdays', startDate: '2026-11-20', endDate: '2026-11-23' }),
    ['2026-11-20', '2026-11-23']
  );
  assert.deepEqual(
    scheduler.expandBulkDates({ mode: 'range_weekends', startDate: '2026-11-20', endDate: '2026-11-23' }),
    ['2026-11-21', '2026-11-22']
  );

  // Unapproved suggested holiday does NOT alter schedule
  const suggested = scheduler.evaluateDatePolicy('2026-12-25', {
    holidays: {
      '2026-12-25': { date: '2026-12-25', name: 'Christmas Day', mode: 'full_skip', approved: false }
    }
  });
  assert.equal(suggested.effectiveMode, 'normal');
  assert.equal(suggested.isSuggestedHoliday, true);
  assert.equal(suggested.isApprovedHoliday, false);

  // Approved holiday DOES enforce full_skip
  const approved = scheduler.evaluateDatePolicy('2026-12-25', {
    holidays: {
      '2026-12-25': { date: '2026-12-25', name: 'Christmas Day', mode: 'full_skip', approved: true }
    }
  });
  assert.equal(approved.effectiveMode, 'full_skip');
  assert.equal(approved.isApprovedHoliday, true);
  assert.equal(approved.ruleSource, 'approved_holiday');
});

test('11. Atomic execution claim gate prevents duplicate execution & module-loader shares scheduler singleton', async () => {
  resetAllState();
  const todayStr = getTodayStr();
  const tOut = getSameDayTimeOffset(45);
  mockSupabase.db.system_config[0].clock_out_base_time = tOut;

  let finishFirst;
  const firstStarted = new Promise((res) => {
    scheduler.__test.setRuntimeDependenciesForTest({
      cronSchedule: createFakeCronHarness().cronSchedule,
      executeClockAction: async () => {
        res();
        await new Promise((r) => { finishFirst = r; });
        return { success: true };
      }
    });
  });

  await scheduler.reconcileSchedule(mockSupabase, { triggerSource: 'startup', force: true });
  const rev = scheduler.getRuntimeSnapshot().currentAppliedRevision;
  const jobId = scheduler.getRuntimeSnapshot().clockOutJobId;

  const p1 = scheduler.__test.executeGatedScheduledAction('clock_out', {
    boundRevision: rev,
    boundJobId: jobId,
    dateString: todayStr,
    plannedTime: tOut
  }, mockSupabase);

  await firstStarted;

  // Concurrent second trigger must be rejected by DUPLICATE_CLAIM
  const p2 = await scheduler.__test.executeGatedScheduledAction('clock_out', {
    boundRevision: rev,
    boundJobId: jobId,
    dateString: todayStr,
    plannedTime: tOut
  }, mockSupabase);
  assert.equal(p2.executed, false);
  assert.match(p2.reason, /DUPLICATE_CLAIM/);

  finishFirst();
  await p1;

  // Verify module-loader shares scheduler singleton instance across repeated & internal sibling requires
  const loadedA = moduleLoader.loadModule('scheduler', scheduler);
  const loadedB = moduleLoader.loadModule('scheduler', scheduler);
  assert.equal(loadedA, loadedB, 'module-loader must return identical cached scheduler instance');
  assert.equal(loadedA.__test.getSchedulerState(), global.__alsSchedulerState);
});

test('12. Strict account & edition boundaries plus RLS/migration security assertions', async () => {
  resetAllState();

  // Hub / non-home device rejected
  cacheManager.saveDeviceConfig({ device_id: 'hub_account_2', device_name: 'Colleague', edition: 'full', auto_clock_enabled: true });
  assert.equal(supabaseClient.isHomeAutoScheduleAgent(), false);
  const resHub = await scheduler.reconcileSchedule(mockSupabase, { triggerSource: 'startup', force: true });
  assert.equal(resHub.skipped, true);
  assert.equal(resHub.authorized, false);
  assert.equal(scheduler.getRuntimeSnapshot().clockOutScheduled, false);

  // Lite edition on home_desktop_agent rejected
  process.env.ALS_EDITION = 'lite';
  cacheManager.saveDeviceConfig({ device_id: 'home_desktop_agent', device_name: 'Home Lite', edition: 'lite', auto_clock_enabled: true });
  assert.equal(supabaseClient.isHomeAutoScheduleAgent(), false);
  const resLite = await scheduler.reconcileSchedule(mockSupabase, { triggerSource: 'startup', force: true });
  assert.equal(resLite.skipped, true);
  assert.equal(resLite.authorized, false);

  // Verify migration SQL enforces RLS, authenticated role, email allowlist, and home_desktop_agent restriction
  const migSql = fs.readFileSync(
    path.join(__dirname, '..', '..', 'supabase', 'migrations', '20261118100000_advanced_scheduling_and_skip_upgrade.sql'),
    'utf8'
  );
  for (const tbl of ['schedule_policy_state', 'schedule_date_overrides', 'schedule_recurring_rules', 'schedule_holidays']) {
    assert.match(migSql, new RegExp(`ENABLE ROW LEVEL SECURITY`, 'i'));
    assert.match(migSql, new RegExp(tbl, 'i'));
  }
  assert.match(migSql, /muhammadafif@upm\.edu\.my/);
  assert.match(migSql, /home_desktop_agent/);
  assert.match(migSql, /TO authenticated/i);
  assert.match(migSql, /save_bulk_schedule_overrides/i);

  // Ensure neither UI HTML contains any Supabase service_role key
  const rootHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
  const deskHtml = fs.readFileSync(path.join(__dirname, '..', 'desktop-ui.html'), 'utf8');
  assert.equal(/service_role/i.test(rootHtml), false);
  assert.equal(/service_role/i.test(deskHtml), false);
});
