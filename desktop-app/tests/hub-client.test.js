process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const hubClient = require('../hub-client');

function createMockSupabase() {
  const updates = [];
  const inserts = [];
  let pendingCommands = [];
  let hasCustomResult = false;
  let updateResult = { data: null, error: null };

  const client = {
    _updates: updates,
    _inserts: inserts,
    _setPendingCommands: (cmds) => { pendingCommands = cmds; },
    _setUpdateResult: (res) => {
      hasCustomResult = true;
      updateResult = res;
    },

    from: (table) => ({
      select: () => ({
        eq: (col1, val1) => ({
          eq: (col2, val2) => ({
            order: () => ({
              limit: async () => ({
                data: pendingCommands.filter(c => c[col1] === val1 && c[col2] === val2),
                error: null
              })
            })
          })
        })
      }),
      insert: async (payload) => {
        inserts.push({ table, payload });
        return { error: null };
      },
      upsert: async (payload) => {
        inserts.push({ table, payload, isUpsert: true });
        return { error: null };
      },
      update: (payload) => ({
        eq: (col1, val1) => ({
          eq: (col2, val2) => ({
            select: () => ({
              maybeSingle: async () => {
                updates.push({ table, payload, filter: { [col1]: val1, [col2]: val2 } });
                return hasCustomResult
                  ? updateResult
                  : { data: { id: val1, ...payload }, error: null };
              }
            })
          }),
          select: () => ({
            maybeSingle: async () => {
              updates.push({ table, payload, filter: { [col1]: val1 } });
              return hasCustomResult
                ? updateResult
                : { data: { id: val1, ...payload }, error: null };
            }
          }),
          then: async (resolve) => {
            updates.push({ table, payload, filter: { [col1]: val1 } });
            return resolve({ error: null });
          }
        })
      })
    }),

    channel: (name) => ({
      name,
      state: 'joined',
      on: function() { return this; },
      subscribe: function(cb) {
        if (typeof cb === 'function') cb('SUBSCRIBED');
        return this;
      }
    }),
    removeChannel: () => {},
    removeAllChannels: () => {}
  };

  return client;
}

test('Hub Client Hardening: Expired commands are marked as failed without executing automation', async () => {
  const mockSupabase = createMockSupabase();
  const executedActions = [];

  hubClient.__test.setRuntimeDependenciesForTest({
    executeClockAction: async (action) => { executedActions.push(action); },
    manualFetchProof: async () => { executedActions.push('manual_proof_sync'); }
  });

  const expiredTimestamp = new Date(Date.now() - 20 * 60 * 1000).toISOString(); // 20 mins ago
  const account = { device_id: 'AMIR' };
  const cmd = {
    id: 101,
    action: 'clock_in',
    status: 'pending',
    created_at: expiredTimestamp
  };

  await hubClient.__test.processHubCommand(mockSupabase, account, cmd, 'recovery');

  // Assert automation was NOT called
  assert.equal(executedActions.length, 0);

  // Assert marked failed in commands table
  const commandUpdate = mockSupabase._updates.find(u => u.table === 'commands' && u.payload.status === 'failed');
  assert.ok(commandUpdate, 'Command must be updated to status failed');

  // Assert expired log entry was inserted
  const logInsert = mockSupabase._inserts.find(i => i.table === 'logs');
  assert.ok(logInsert, 'Log entry must be inserted');
  assert.match(logInsert.payload.message, /expired before processing/);

  hubClient.__test.resetRuntimeDependencies();
});

test('Hub Client Hardening: Fresh commands are claimed atomically and executed', async () => {
  const mockSupabase = createMockSupabase();
  const executedActions = [];

  hubClient.__test.setRuntimeDependenciesForTest({
    executeClockAction: async (action, client, opts) => {
      executedActions.push({ action, device_id: opts.hubAccount.device_id });
    },
    manualFetchProof: async () => {}
  });

  const freshTimestamp = new Date(Date.now() - 60 * 1000).toISOString(); // 1 min ago
  const account = { device_id: 'AMIR' };
  const cmd = {
    id: 102,
    action: 'clock_in',
    status: 'pending',
    created_at: freshTimestamp
  };

  await hubClient.__test.processHubCommand(mockSupabase, account, cmd, 'recovery');

  // Assert automation executed
  assert.equal(executedActions.length, 1);
  assert.equal(executedActions[0].action, 'clock_in');
  assert.equal(executedActions[0].device_id, 'AMIR');

  // Assert marked completed
  const completedUpdate = mockSupabase._updates.find(u => u.table === 'commands' && u.payload.status === 'completed');
  assert.ok(completedUpdate, 'Command must be updated to completed');

  hubClient.__test.resetRuntimeDependencies();
});

test('Hub Client Hardening: recoverPendingCommands fetches and drains queued commands', async () => {
  const mockSupabase = createMockSupabase();
  const executedActions = [];

  hubClient.__test.setRuntimeDependenciesForTest({
    executeClockAction: async (action) => { executedActions.push(action); },
    manualFetchProof: async () => { executedActions.push('manual_proof_sync'); }
  });

  const freshTimestamp = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  mockSupabase._setPendingCommands([
    { id: 201, action: 'manual_proof_sync', status: 'pending', device_id: 'AMIR', created_at: freshTimestamp },
    { id: 202, action: 'clock_out', status: 'pending', device_id: 'AMIR', created_at: freshTimestamp }
  ]);

  const account = { device_id: 'AMIR' };
  await hubClient.__test.recoverPendingCommands(mockSupabase, account, 'heartbeat_poll');

  // Wait for queue processing
  await hubClient.__test.processQueue();

  assert.equal(executedActions.length, 2);
  assert.deepEqual(executedActions, ['manual_proof_sync', 'clock_out']);

  hubClient.__test.resetRuntimeDependencies();
});

test('Hub Client Hardening: startHubHeartbeat automatically triggers pending command recovery', async () => {
  const mockSupabase = createMockSupabase();
  const executedActions = [];

  hubClient.__test.setRuntimeDependenciesForTest({
    executeClockAction: async (action) => { executedActions.push(action); },
    manualFetchProof: async () => { executedActions.push('manual_proof_sync'); }
  });

  const freshTimestamp = new Date(Date.now() - 30 * 1000).toISOString();
  mockSupabase._setPendingCommands([
    { id: 301, action: 'clock_in', status: 'pending', device_id: 'AMIR', created_at: freshTimestamp }
  ]);

  const account = { device_id: 'AMIR', device_name: 'Amir PC' };
  
  // Start heartbeat (fires immediate ping)
  hubClient.__test.startHubHeartbeat(mockSupabase, account);

  // Give immediate ping a tick to execute
  await new Promise(r => setTimeout(r, 50));
  await hubClient.__test.processQueue();

  // Stop intervals
  hubClient.stopHubAccounts();

  // Assert heartbeat upsert happened
  const statusUpsert = mockSupabase._inserts.find(i => i.table === 'device_status' && i.isUpsert);
  assert.ok(statusUpsert, 'device_status upsert must happen during heartbeat');
  assert.equal(statusUpsert.payload.device_id, 'AMIR');
  assert.equal(statusUpsert.payload.current_status, 'ONLINE (HUB)');

  // Assert recovery executed command
  assert.equal(executedActions.length, 1);
  assert.equal(executedActions[0], 'clock_in');

  hubClient.__test.resetRuntimeDependencies();
});

test('Hub Client Hardening: Atomic claiming prevents duplicate execution if already claimed', async () => {
  const mockSupabase = createMockSupabase();
  const executedActions = [];

  hubClient.__test.setRuntimeDependenciesForTest({
    executeClockAction: async (action) => { executedActions.push(action); },
    manualFetchProof: async () => {}
  });

  // Simulate command already claimed by another runner
  mockSupabase._setUpdateResult({ data: null, error: null });

  const freshTimestamp = new Date(Date.now() - 30 * 1000).toISOString();
  const account = { device_id: 'AMIR' };
  const cmd = { id: 401, action: 'clock_in', status: 'pending', created_at: freshTimestamp };

  await hubClient.__test.processHubCommand(mockSupabase, account, cmd, 'recovery');

  // Should NOT execute
  assert.equal(executedActions.length, 0);

  hubClient.__test.resetRuntimeDependencies();
});

