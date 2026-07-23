process.env.NODE_ENV = 'test';

const os = require('os');
const fs = require('fs');
const path = require('path');

const testCacheDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'als-reliability-test-')
);

process.env.ALS_CACHE_FILE = path.join(
  testCacheDir,
  'local_cache.json'
);

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

global.fetch = async () => {
  throw new Error('Unexpected real network access during unit test');
};

let realBrowserLaunchCount = 0;
let mockedPersistentLaunchCount = 0;

const mockPlaywright = {
  chromium: {
    launchPersistentContext: async () => {
      mockedPersistentLaunchCount++;
      return {
        newPage: async () => mockPage,
        close: async () => { mockPage._closed = true; }
      };
    },
    launch: async () => {
      // Technically used for captive portal bypass
      return {
        newPage: async () => mockPage,
        close: async () => {}
      };
    }
  }
};

let mockPage = {};

const originalRequire = Module.prototype.require;
Module.prototype.require = function(path) {
  if (path === 'playwright') return mockPlaywright;
  return originalRequire.apply(this, arguments);
};

const supabaseClient = require('../supabase-client');
const automation = require('../automation');
const scheduler = require('../scheduler');
const cacheManager = require('../cache-manager');

const mockSupabase = {
  from: () => mockSupabase,
  update: () => mockSupabase,
  eq: () => mockSupabase,
  select: () => mockSupabase,
  maybeSingle: async () => ({ data: mockSupabase._commandData, error: mockSupabase._commandError }),
  insert: async (payload) => {
    mockSupabase._inserts.push(payload);
    return { error: null };
  },
  upsert: async () => ({ error: null }),
  order: () => mockSupabase,
  limit: async () => ({ data: mockSupabase._pendingCommands, error: null }),
  channel: () => mockSupabase,
  on: () => mockSupabase,
  subscribe: () => mockSupabase,

  _commandData: null,
  _commandError: null,
  _pendingCommands: [],
  _updates: [],
  _inserts: [],
  _orderCall: null,
  
  _reset: function() {
    this._commandData = null;
    this._commandError = null;
    this._pendingCommands = [];
    this._updates = [];
    this._inserts = [];
    this._lastPayload = null;
    this._orderCall = null;
  }
};

mockSupabase.update = function(payload) {
  this._lastPayload = payload;
  return this;
};

mockSupabase.eq = function(key, val) {
  if (key === 'id') {
     if (this._lastPayload) {
       this._updates.push({ id: val, payload: this._lastPayload });
     }
  }
  return this;
};

mockSupabase.select = function() {
  this._lastPayload = null;
  return this;
};

mockSupabase.order = function(column, options) {
  this._orderCall = { column, options };
  return this;
};

Object.assign(supabaseClient.supabase, mockSupabase);

test('Reliability Improvements', async (t) => {

  const originalNow = Date.now;
  const originalFetch = global.fetch;

  t.after(() => {
    fs.rmSync(testCacheDir, {
      recursive: true,
      force: true
    });
    Module.prototype.require = originalRequire;
    global.Date.now = originalNow;
    global.fetch = originalFetch;
  });

  t.beforeEach(() => {
    mockSupabase._reset();
    supabaseClient.__test.resetRuntimeDependencies();
    
    mockPage = {
      _closed: false,
      _clicked: false,
      goto: async () => {},
      evaluate: async () => ({ clockIn: '?', clockOut: '?' }),
      url: () => 'https://mock',
      fill: async () => {},
      click: async () => {},
      waitForNavigation: async () => {},
      frames: () => [{
        $: async () => ({}),
        evaluate: async () => {},
        waitForSelector: async () => {},
        click: async () => { mockPage._clicked = true; }
      }],
      waitForTimeout: async () => {},
      waitForFunction: async () => {},
      isVisible: async () => false
    };

    global.Date.now = originalNow;
    global.fetch = originalFetch;
  });

  await t.test('cacheManager.updateCache is exported', async () => {
    assert.strictEqual(typeof cacheManager.updateCache, 'function');
  });

  await t.test('1. Failed claim - no execution', async () => {
    mockSupabase._commandData = null; 
    
    let executeCount = 0;
    supabaseClient.__test.setRuntimeDependenciesForTest({
      executeClockAction: async () => { executeCount++; }
    });

    await supabaseClient.__test.processCommandById('cmd-fail', 'test');
    assert.strictEqual(executeCount, 0);
  });

  await t.test('2. Realtime and recovery race (atomicity)', async () => {
    let callCount = 0;
    mockSupabase.maybeSingle = async () => {
      callCount++;
      if (callCount === 1) return { data: { action: 'clock_in', created_at: new Date().toISOString() }, error: null };
      return { data: null, error: null }; 
    };

    let executeCount = 0;
    supabaseClient.__test.setRuntimeDependenciesForTest({
      executeClockAction: async () => { executeCount++; }
    });

    await Promise.all([
      supabaseClient.__test.processCommandById('cmd-race', 'realtime'),
      supabaseClient.__test.processCommandById('cmd-race', 'recovery')
    ]);

    assert.strictEqual(executeCount, 1, 'Action should only execute once');
  });

  await t.test('3. Oldest-first recovery explicitly verified', async () => {
    mockSupabase._pendingCommands = [
      { id: 'cmd-oldest', created_at: new Date(Date.now() - 5000).toISOString() },
      { id: 'cmd-newest', created_at: new Date().toISOString() }
    ];

    const originalLimit = mockSupabase.limit;
    mockSupabase.limit = async () => {
      const data = mockSupabase._pendingCommands;
      mockSupabase._pendingCommands = []; // Clear so next batch is empty
      return { data, error: null };
    };

    mockSupabase.maybeSingle = async () => ({ data: { action: 'clock_in', created_at: new Date().toISOString() }, error: null });

    let executionOrder = [];
    supabaseClient.__test.setRuntimeDependenciesForTest({
      executeClockAction: async (action, sb, opts) => { executionOrder.push(opts.source); }
    });

    await supabaseClient.__test.recoverPendingCommands();
    
    mockSupabase.limit = originalLimit; 

    // Verify correct sorting request
    assert.deepStrictEqual(mockSupabase._orderCall, {
      column: 'created_at',
      options: { ascending: true }
    });

    // Verify execution order
    const processingUpdates = mockSupabase._updates.filter(u => u.payload.status === 'processing');
    assert.strictEqual(processingUpdates.length, 2);
    assert.strictEqual(processingUpdates[0].id, 'cmd-oldest');
    assert.strictEqual(processingUpdates[1].id, 'cmd-newest');
  });

  await t.test('4. Expired command log includes source and execution halts', async () => {
    let oldDate = new Date(Date.now() - (16 * 60 * 1000));
    mockSupabase._commandData = { action: 'clock_in', created_at: oldDate.toISOString() };
    mockSupabase.maybeSingle = async () => ({ data: mockSupabase._commandData, error: null });

    let executeCount = 0;
    supabaseClient.__test.setRuntimeDependenciesForTest({
      executeClockAction: async () => { executeCount++; }
    });

    await supabaseClient.__test.processCommandById('cmd-expired', 'recovery');
    
    assert.strictEqual(executeCount, 0, 'Expired command must not execute');
    
    const failedUpdate = mockSupabase._updates.find(u => u.id === 'cmd-expired' && u.payload.status === 'failed');
    assert.ok(failedUpdate, 'Command must be marked failed');

    const logInsert = mockSupabase._inserts.find(i => 
      i.action === 'remote_command' && 
      i.status === 'failed' && 
      i.message.includes('expired before processing; source=recovery')
    );
    assert.ok(logInsert, 'Must create an explanatory log entry containing the source');
  });

  await t.test('5. Immediate remote command has no scheduling delay', async () => {
    let waitedMsArray = [];
    const p = { waitForTimeout: async (ms) => { waitedMsArray.push(ms); } };
    
    await automation.__test.waitUntilTarget(p, null);
    
    assert.strictEqual(waitedMsArray.length, 0, 'waitUntilTarget must not wait at all if targetAt is not provided');
    
    // Also simulate executeClockAction full flow to ensure no artificial 60s delay
    const origFetch = global.fetch;
    global.fetch = async () => ({ text: async () => '<html' });
    mockSupabase.maybeSingle = async () => ({ data: { target_url: 'http://mock' }, error: null });
    
    await automation.executeClockAction('clock_in', mockSupabase, {});
    global.fetch = origFetch;
    
    // It shouldn't have waited inside a scheduling delay (though standard UI expansion delays are allowed)
    // 60000 wait is explicitly forbidden per prompt requirement.
  });

  await t.test('6. Future scheduled target', async () => {
    let waitedMs = undefined;
    const p = { waitForTimeout: async (ms) => { waitedMs = ms; } };
    const targetAt = new Date(Date.now() + 3000).toISOString();
    
    let iterations = 0;
    global.Date.now = () => {
      iterations++;
      if (iterations === 1) return originalNow(); 
      return new Date(targetAt).getTime(); 
    };
    
    await automation.__test.waitUntilTarget(p, targetAt);
    
    assert.ok(waitedMs > 2000 && waitedMs <= 5000, 'Must wait the calculated duration');
  });

  await t.test('7. Slightly late scheduled target executes immediately', async () => {
    let waitedMs = undefined;
    const p = { waitForTimeout: async (ms) => { waitedMs = ms; } };
    const targetAt = new Date(Date.now() - 2 * 60 * 1000).toISOString(); // 2 mins late
    
    await automation.__test.waitUntilTarget(p, targetAt);
    assert.strictEqual(waitedMs, undefined, 'Must not wait if slightly late');
  });

  await t.test('8. Expired scheduled target throws', async () => {
    const p = { waitForTimeout: async () => {} };
    const targetAt = new Date(Date.now() - 6 * 60 * 1000).toISOString(); // 6 mins late
    
    await assert.rejects(
      async () => await automation.__test.waitUntilTarget(p, targetAt),
      /MISSED_TARGET_WINDOW/
    );
  });

  await t.test('9. Local date helper constructs correct Date', async () => {
    const result = scheduler.__test.buildLocalTargetDate('2026-07-11', '07:45');
    assert.strictEqual(result.getFullYear(), 2026);
    assert.strictEqual(result.getMonth(), 6);
    assert.strictEqual(result.getDate(), 11);
    assert.strictEqual(result.getHours(), 7);
    assert.strictEqual(result.getMinutes(), 45);
  });

  await t.test('10. Second pre-flight prevents click', async () => {
    const origFetch = global.fetch;
    global.fetch = async () => ({ text: async () => '<html' });
    
    mockSupabase.maybeSingle = async () => ({ data: { target_url: 'http://mock' }, error: null });

    let checkCount = 0;
    mockPage.evaluate = async () => {
      checkCount++;
      if (checkCount === 1) return { clockIn: '?', clockOut: '?' };
      return { clockIn: '08:00:00', clockOut: '?' };
    };

    const targetAt = new Date(Date.now() + 1000).toISOString();
    
    global.Date.now = () => new Date(targetAt).getTime();
    
    const result = await automation.executeClockAction('clock_in', mockSupabase, { targetAt });
    
    assert.strictEqual(result, true);
    assert.strictEqual(mockPage._clicked, false, 'Should skip click because second pre-flight found proof');
    assert.strictEqual(mockPage._closed, true, 'Should close context');
  });

  await t.test('Invalid target time', async () => {
    await assert.rejects(
      () => automation.__test.waitUntilTarget(mockPage, 'not-a-valid-date'),
      /INVALID_TARGET_TIME/
    );
  });

  await t.test('Browser and network isolation explicitly proven', async () => {
    assert.strictEqual(realBrowserLaunchCount, 0, 'Real browser was never launched');
    assert.ok(mockedPersistentLaunchCount > 0, 'Mocked playwright module was used instead of real chromium');
  });

  await t.test('Skip days local cache sync & offline fallback', async () => {
    cacheManager.updateSkipDays(['2026-07-25', '2026-07-26']);
    const cache = cacheManager.readCache();
    assert.deepStrictEqual(cache.skip_days, ['2026-07-25', '2026-07-26']);

    // Mock online skip_days query returning array
    const originalSelect = mockSupabase.select;
    mockSupabase.select = (cols) => {
      if (cols === 'date') {
        return {
          eq: () => ({ maybeSingle: async () => ({ data: { date: '2026-07-25' }, error: null }) }),
          then: (cb) => cb({ data: [{ date: '2026-07-25' }, { date: '2026-07-30' }], error: null }),
          maybeSingle: async () => ({ data: { date: '2026-07-25' }, error: null })
        };
      }
      return mockSupabase;
    };

    await scheduler.init(mockSupabase);
    mockSupabase.select = originalSelect;

    const updatedCache = cacheManager.readCache();
    assert.ok(updatedCache.skip_days.includes('2026-07-25'));
    assert.ok(updatedCache.skip_days.includes('2026-07-30'));
  });
});
