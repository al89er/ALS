const { createClient } = require('@supabase/supabase-js');
const { executeClockAction, manualFetchProof } = require('./automation');
const cacheManager = require('./cache-manager');

const runtimeDependencies = {
  executeClockAction,
  manualFetchProof
};

function setRuntimeDependenciesForTest(overrides) {
  Object.assign(runtimeDependencies, overrides);
}

function resetRuntimeDependencies() {
  runtimeDependencies.executeClockAction = executeClockAction;
  runtimeDependencies.manualFetchProof = manualFetchProof;
}

const PENDING_COMMAND_MAX_AGE_MS = 15 * 60 * 1000;
let isExecuting = false;
let queuePromise = Promise.resolve();
const commandQueue = [];
const activeClients = new Map();
const activeChannels = new Map();
const activeIntervals = new Map();
const activeRecoveries = new Set();

function processQueue() {
  if (isExecuting) return queuePromise;
  isExecuting = true;
  queuePromise = (async () => {
    while (commandQueue.length > 0) {
      const task = commandQueue.shift();
      try {
        await task();
      } catch (err) {
        console.error('[HUB] Execution error:', err);
      }
    }
    isExecuting = false;
  })();
  return queuePromise;
}

async function processHubCommand(supabase, account, cmd, source = 'realtime') {
  if (!cmd || !cmd.id) return;
  const deviceId = account.device_id;
  const createdAtMs = new Date(cmd.created_at).getTime();
  const commandAgeMs = Number.isFinite(createdAtMs) ? Date.now() - createdAtMs : 0;

  if (commandAgeMs > PENDING_COMMAND_MAX_AGE_MS) {
    console.warn(`[HUB] Pending command ${cmd.id} for ${deviceId} expired before processing (age: ${Math.round(commandAgeMs / 1000)}s).`);
    try {
      await supabase.from('logs').insert({
        action: 'remote_command',
        status: 'failed',
        message: `Command ${cmd.id} expired before processing; source=${source}`,
        device_id: deviceId
      });
    } catch (logErr) {
      console.error(`[HUB] Error logging expired command ${cmd.id}:`, logErr.message);
    }

    try {
      await supabase
        .from('commands')
        .update({ status: 'failed', updated_at: new Date().toISOString() })
        .eq('id', cmd.id);
    } catch (failErr) {
      console.error(`[HUB] Error marking expired command ${cmd.id} as failed:`, failErr.message);
    }
    return;
  }

  const validActions = ['clock_in', 'clock_out', 'ot_in', 'ot_out', 'manual_proof_sync'];
  if (!validActions.includes(cmd.action)) {
    console.warn(`[HUB] Unknown action for ${deviceId}: ${cmd.action}`);
    await supabase
      .from('commands')
      .update({ status: 'failed', updated_at: new Date().toISOString() })
      .eq('id', cmd.id);
    return;
  }

  // Claim atomically: only proceed if state is still 'pending'
  const { data: claimed, error: claimError } = await supabase
    .from('commands')
    .update({ status: 'processing', updated_at: new Date().toISOString() })
    .eq('id', cmd.id)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle();

  if (claimError) {
    console.error(`[HUB] Failed to claim command ${cmd.id} for ${deviceId}:`, claimError.message);
    return;
  }

  if (!claimed) {
    console.log(`[HUB] Command ${cmd.id} for ${deviceId} could not be claimed (already claimed or not pending).`);
    return;
  }

  console.log(`[HUB] Processing claimed command for ${deviceId}: ${cmd.action} (source=${source})`);

  try {
    if (cmd.action === 'clock_in' || cmd.action === 'clock_out' || cmd.action === 'ot_in' || cmd.action === 'ot_out') {
      await runtimeDependencies.executeClockAction(cmd.action, supabase, { source: source || 'hub_manual', hubAccount: account });
    } else if (cmd.action === 'manual_proof_sync') {
      await runtimeDependencies.manualFetchProof(supabase, { source: source || 'hub_manual', hubAccount: account });
    }

    await supabase
      .from('commands')
      .update({ status: 'completed', updated_at: new Date().toISOString() })
      .eq('id', cmd.id);
    console.log(`[HUB] Command ${cmd.id} for ${deviceId} marked as completed.`);
  } catch (err) {
    console.error(`[HUB] Command execution failed for ${deviceId}:`, err);
    await supabase
      .from('commands')
      .update({ status: 'failed', updated_at: new Date().toISOString() })
      .eq('id', cmd.id);
  }
}

function initHubAccounts() {
  const accounts = cacheManager.getHubAccounts();
  const envVars = cacheManager.getDeviceConfig();
  
  const supabaseUrl = envVars.supabase_url;
  const supabaseKey = envVars.supabase_key;

  if (!supabaseUrl || !supabaseKey) {
    console.warn('[HUB] Missing global Supabase URL/Key. Cannot initialize clients.');
    return;
  }

  stopHubAccounts();

  for (const account of accounts) {
    if (!account.supabase_email || !account.supabase_password) continue;

    console.log(`[HUB] Initializing isolated client for ${account.device_id}...`);
    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storageKey: `hub-auth-${account.device_id}`
      }
    });

    supabase.auth.onAuthStateChange((event, session) => {
      if (session && session.access_token) {
        try {
          supabase.realtime.setAuth(session.access_token);
        } catch (authErr) {
          console.warn(`[HUB] Failed to set realtime auth for ${account.device_id}:`, authErr.message);
        }
      }
    });
    
    supabase.auth.signInWithPassword({
      email: account.supabase_email,
      password: account.supabase_password
    }).then(({ data, error }) => {
      if (error) {
        console.error(`[HUB] Auth failed for ${account.device_id}:`, error.message);
        return;
      }
      activeClients.set(account.device_id, supabase);
      startHubHeartbeat(supabase, account);
      startHubCommandListener(supabase, account);
    }).catch(err => {
      console.error(`[HUB] Exception during auth for ${account.device_id}:`, err.message);
    });
  }
}

function stopHubAccounts() {
  for (const [deviceId, intervalId] of activeIntervals.entries()) {
    clearInterval(intervalId);
  }
  activeIntervals.clear();

  for (const [deviceId, client] of activeClients.entries()) {
    try {
      client.removeAllChannels();
    } catch (e) {}
  }
  activeClients.clear();
  activeChannels.clear();
  activeRecoveries.clear();
}

function startHubHeartbeat(supabase, account) {
  const deviceId = account.device_id;

  if (activeIntervals.has(deviceId)) {
    clearInterval(activeIntervals.get(deviceId));
  }

  const ping = async () => {
    try {
      const { error } = await supabase
        .from('device_status')
        .upsert({ 
          id: deviceId, 
          device_id: deviceId,
          device_name: account.device_name || 'Hub Account',
          current_status: 'ONLINE (HUB)', 
          last_seen: new Date().toISOString() 
        });

      if (error) {
        console.error(`[HUB] Heartbeat failed for ${deviceId}:`, error.message);
      } else {
        // Channel health check: if channel degraded/closed, re-subscribe
        const currentChannel = activeChannels.get(deviceId);
        if (currentChannel && (currentChannel.state === 'closed' || currentChannel.state === 'errored')) {
          console.log(`[HUB] Re-subscribing degraded channel for ${deviceId} (state: ${currentChannel.state})...`);
          startHubCommandListener(supabase, account);
        }

        // Heartbeat recovery fallback: drains any pending commands missed during sleep/network outage
        await recoverPendingCommands(supabase, account, 'heartbeat_poll');
      }
    } catch (err) {
      // Ignore network drops gracefully
    }
  };

  ping();
  const intervalId = setInterval(ping, 30000);
  activeIntervals.set(deviceId, intervalId);
}

function startHubCommandListener(supabase, account) {
  const deviceId = account.device_id;

  const existingChannel = activeChannels.get(deviceId);
  if (existingChannel) {
    try {
      supabase.removeChannel(existingChannel);
    } catch (e) {}
  }

  const channel = supabase.channel(`public:commands:${deviceId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'commands', filter: `device_id=eq.${deviceId}` },
      (payload) => {
        const cmd = payload.new;
        if (!cmd) return;
        console.log(`[HUB] Received realtime command for ${deviceId}: ${cmd.action} (id=${cmd.id})`);
        
        commandQueue.push(() => processHubCommand(supabase, account, cmd, 'realtime'));
        processQueue();
      }
    )
    .subscribe((status, err) => {
      console.log(`[HUB] Command listener subscription status for ${deviceId}: ${status}`);
      if (status === 'SUBSCRIBED') {
        recoverPendingCommands(supabase, account, 'realtime_subscribed');
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        console.warn(`[HUB] Command listener channel degraded for ${deviceId}: ${status}. Error:`, err ? err.message : 'none');
      }
    });

  activeChannels.set(deviceId, channel);
  return channel;
}

async function recoverPendingCommands(supabase, account, source = 'recovery') {
  const deviceId = account.device_id;
  if (activeRecoveries.has(deviceId)) return;
  activeRecoveries.add(deviceId);

  try {
    let hasMore = true;
    let iterations = 0;
    while (hasMore && iterations < 5) {
      iterations++;
      const { data: pendingCommands, error } = await supabase
        .from('commands')
        .select('id, action, created_at, device_id')
        .eq('status', 'pending')
        .eq('device_id', deviceId)
        .order('created_at', { ascending: true })
        .limit(20);

      if (error) {
        console.error(`[HUB] Error fetching pending commands for ${deviceId}:`, error.message);
        break;
      }

      if (pendingCommands && pendingCommands.length > 0) {
        console.log(`[HUB] Found ${pendingCommands.length} pending commands for ${deviceId} (source=${source}, batch ${iterations}).`);
        for (const cmd of pendingCommands) {
          commandQueue.push(() => processHubCommand(supabase, account, cmd, source));
        }
        await processQueue();
        if (pendingCommands.length < 20) {
          hasMore = false;
        }
      } else {
        hasMore = false;
      }
    }
  } catch (err) {
    console.error(`[HUB] Unexpected error during command recovery for ${deviceId}:`, err.message);
  } finally {
    activeRecoveries.delete(deviceId);
  }
}

async function getHubAccountStatus(deviceId) {
  let client = activeClients.get(deviceId);
  if (!client) {
    client = await getHubClientForDevice(deviceId);
  }
  if (!client) {
    return { status: null, proof: null, logs: [] };
  }

  const todayStr = new Date().toLocaleDateString('en-CA');
  
  try {
    const [statusRes, proofRes, logsRes] = await Promise.all([
      client.from('device_status').select('current_status, last_seen').eq('device_id', deviceId).maybeSingle(),
      client.from('todays_proof').select('*').eq('device_id', deviceId).eq('date', todayStr).maybeSingle(),
      client.from('logs').select('*').eq('device_id', deviceId).order('created_at', { ascending: false }).limit(20)
    ]);

    return {
      status: statusRes.data || null,
      proof: proofRes.data || null,
      logs: logsRes.data || []
    };
  } catch (err) {
    console.error(`[HUB] Error fetching status for ${deviceId}:`, err);
    return { status: null, proof: null, logs: [] };
  }
}

async function getHubClientForDevice(deviceId) {
  if (activeClients.has(deviceId)) {
    return activeClients.get(deviceId);
  }
  const accounts = cacheManager.getHubAccounts();
  const account = accounts.find(a => a.device_id === deviceId);
  if (!account || !account.supabase_email || !account.supabase_password) return null;

  const envVars = cacheManager.getDeviceConfig();
  const supabaseUrl = envVars.supabase_url;
  const supabaseKey = envVars.supabase_key;
  if (!supabaseUrl || !supabaseKey) return null;

  try {
    const client = createClient(supabaseUrl, supabaseKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storageKey: `hub-auth-${account.device_id}`
      }
    });

    const { data, error } = await client.auth.signInWithPassword({
      email: account.supabase_email,
      password: account.supabase_password
    });
    if (error) {
      console.error(`[HUB] Authentication failed for ${deviceId}:`, error.message);
      return null;
    }
    activeClients.set(deviceId, client);
    return client;
  } catch (err) {
    console.error(`[HUB] Error creating client for ${deviceId}:`, err.message);
    return null;
  }
}

const VERSION = '1.5.8';

module.exports = {
  VERSION,
  initHubAccounts,
  stopHubAccounts,
  getHubAccountStatus,
  getHubClientForDevice,
  __test: {
    processHubCommand,
    recoverPendingCommands,
    startHubHeartbeat,
    startHubCommandListener,
    processQueue,
    setRuntimeDependenciesForTest,
    resetRuntimeDependencies,
    PENDING_COMMAND_MAX_AGE_MS,
    activeClients,
    activeChannels,
    activeIntervals,
    activeRecoveries,
    commandQueue
  }
};

