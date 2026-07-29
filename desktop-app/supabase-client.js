const path = require('path');
if (process.env.NODE_ENV !== 'test') {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
}
const { createClient } = require('@supabase/supabase-js');
const { executeClockAction, manualFetchProof } = require('./automation'); // Import Playwright logic

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
const cacheManager = require('./cache-manager');

function getDeviceId() {
  const config = cacheManager.getDeviceConfig();
  return config.device_id || process.env.DEVICE_ID || 'home_desktop_agent';
}

function getDeviceName() {
  const config = cacheManager.getDeviceConfig();
  return config.device_name || process.env.DEVICE_NAME || 'Home Desktop Agent';
}

function getEffectiveSupabaseConfig() {
  const config = cacheManager.getDeviceConfig();
  const url = config.supabase_url || process.env.SUPABASE_URL || 'https://placeholder.supabase.co';
  const key = config.supabase_key || process.env.SUPABASE_SERVICE_ROLE_KEY || 'placeholder';
  return { url, key };
}

const activeConfig = getEffectiveSupabaseConfig();
if (!process.env.SUPABASE_URL && activeConfig.url.includes('placeholder')) {
  console.warn('Missing Supabase URL or Service Role Key in environment/settings.');
}

const supabase = createClient(activeConfig.url, activeConfig.key);

const PENDING_COMMAND_MAX_AGE_MS = 15 * 60 * 1000;
let isRecovering = false;
let processingPromise = Promise.resolve();

async function processCommandById(commandId, source = 'unknown') {
  return new Promise((resolve) => {
    processingPromise = processingPromise.then(async () => {
      try {
        const deviceId = getDeviceId();
        const { data: command, error: claimError } = await supabase
          .from('commands')
          .update({ status: 'processing' })
          .eq('id', commandId)
          .eq('status', 'pending')
          .select('*')
          .maybeSingle();

        if (claimError) {
          console.error(`[SUPABASE] Failed to claim command ${commandId}:`, claimError.message);
          return;
        }

        if (!command) {
          console.log(`[SUPABASE] Command ${commandId} could not be claimed (already processed or not pending).`);
          return;
        }

        if (command.device_id && command.device_id !== deviceId && command.device_id !== 'home_desktop_agent') {
          console.log(`[SUPABASE] Command ${commandId} is intended for device ${command.device_id}, skipping (current: ${deviceId}).`);
          return;
        }

        const commandAgeMs = Date.now() - new Date(command.created_at).getTime();
        if (commandAgeMs > PENDING_COMMAND_MAX_AGE_MS) {
          console.warn(`[SUPABASE] Pending command ${commandId} expired before the desktop agent reconnected.`);
          const { error: logError } = await supabase.from('logs').insert({
            action: 'remote_command',
            status: 'failed',
            message: `Command ${commandId} expired before processing; source=${source}`,
            device_id: deviceId
          });
          if (logError) console.error(`[SUPABASE] Error logging expired command ${commandId}:`, logError.message);

          const { error: failError } = await supabase
            .from('commands')
            .update({ status: 'failed' }) 
            .eq('id', commandId);
          if (failError) console.error(`[SUPABASE] Error marking expired command ${commandId} as failed:`, failError.message);
          return;
        }

        const action = command.action;
        const validActions = ['clock_in', 'clock_out', 'manual_proof_sync'];
        if (!validActions.includes(action)) {
          console.warn(`[SUPABASE] Unknown action: ${action}`);
          const { error: failError } = await supabase
            .from('commands')
            .update({ status: 'failed' })
            .eq('id', commandId);
          if (failError) console.error(`[SUPABASE] Error marking unknown command ${commandId} as failed:`, failError.message);
          return;
        }

        console.log(`[SUPABASE] Processing claimed command for ${deviceId}: ${action}`);

        try {
          if (action === 'clock_in' || action === 'clock_out') {
            await runtimeDependencies.executeClockAction(action, supabase, { source, device_id: deviceId });
          } else if (action === 'manual_proof_sync') {
            await runtimeDependencies.manualFetchProof(supabase, { device_id: deviceId });
          }

          const { error: compError } = await supabase
            .from('commands')
            .update({ status: 'completed' })
            .eq('id', commandId);
          if (compError) console.error(`[SUPABASE] Error marking command ${commandId} as completed:`, compError.message);
          else console.log(`[SUPABASE] Command ${commandId} marked as completed.`);
        } catch (execError) {
          const { error: failError } = await supabase
            .from('commands')
            .update({ status: 'failed' })
            .eq('id', commandId);
          if (failError) console.error(`[SUPABASE] Error marking command ${commandId} as failed after exec error:`, failError.message);
          else console.error(`[SUPABASE] Command ${commandId} marked as failed due to Playwright error.`);
        }
      } catch (err) {
        console.error(`[SUPABASE] Unexpected error in processCommandById for ${commandId}:`, err.message);
      } finally {
        resolve();
      }
    });
  });
}

async function recoverPendingCommands() {
  if (isRecovering) return;
  isRecovering = true;
  try {
    const deviceId = getDeviceId();
    console.log(`[SUPABASE] Starting offline command recovery for device ${deviceId}...`);
    let hasMore = true;
    let iterations = 0;
    while (hasMore && iterations < 5) {
      iterations++;
      const { data: pendingCommands, error } = await supabase
        .from('commands')
        .select('id, created_at, device_id')
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
        .limit(20);

      if (error) {
        console.error('[SUPABASE] Error fetching pending commands for recovery:', error.message);
        break;
      }

      if (pendingCommands && pendingCommands.length > 0) {
        const filtered = pendingCommands.filter(c => !c.device_id || c.device_id === deviceId || c.device_id === 'home_desktop_agent');
        if (filtered.length > 0) {
          console.log(`[SUPABASE] Found ${filtered.length} pending commands for recovery (batch ${iterations}).`);
          for (const cmd of filtered) {
            await processCommandById(cmd.id, 'recovery');
          }
        } else {
          hasMore = false;
        }
      } else {
        if (iterations === 1) {
          console.log('[SUPABASE] No pending commands found for recovery.');
        }
        hasMore = false;
      }
    }
  } catch (err) {
    console.error('[SUPABASE] Unexpected error during command recovery:', err.message);
  } finally {
    isRecovering = false;
  }
}

async function reconcileCache() {
  const cache = cacheManager.readCache();
  const deviceId = getDeviceId();

  if (cache.system_config && cache.system_config.synced === false) {
    console.log('[SUPABASE] Reconciling offline system_config to cloud...');
    const payload = { ...cache.system_config };
    delete payload.synced;
    
    const { error } = await supabase.from('system_config').upsert({ id: 1, ...payload });
    if (!error) {
      console.log('[SUPABASE] system_config reconciliation successful.');
      cacheManager.mergeSystemConfig({}, true);
    } else {
      console.error('[SUPABASE] system_config reconciliation failed:', error.message);
    }
  }

  if (cache.daily_schedule && cache.daily_schedule.synced === false) {
    console.log('[SUPABASE] Reconciling offline daily_schedule to cloud...');
    const payload = { ...cache.daily_schedule, device_id: deviceId };
    delete payload.synced;
    
    const { error } = await supabase.from('daily_schedules').upsert(payload);
    if (!error) {
      console.log('[SUPABASE] daily_schedules reconciliation successful.');
      cacheManager.mergeDailySchedule({}, true);
    } else {
      console.error('[SUPABASE] daily_schedules reconciliation failed:', error.message);
    }
  }

  if (cache.todays_proof && cache.todays_proof.synced === false) {
    console.log('[SUPABASE] Reconciling offline todays_proof to cloud...');
    const payload = { ...cache.todays_proof };
    delete payload.synced;

    const { error } = await supabase.from('todays_proof').upsert({
      date: payload.date,
      clock_in: payload.clock_in,
      clock_out: payload.clock_out,
      device_id: deviceId,
      updated_at: new Date().toISOString()
    }, { onConflict: 'date' });
    
    if (!error) {
      console.log('[SUPABASE] todays_proof reconciliation successful.');
      cacheManager.clearProofIfSynced();
    } else {
      console.error('[SUPABASE] todays_proof reconciliation failed:', error.message);
    }
  }

  if (cache.offline_logs && cache.offline_logs.length > 0) {
    console.log(`[SUPABASE] Reconciling ${cache.offline_logs.length} offline logs to cloud...`);
    const logsWithDevice = cache.offline_logs.map(l => ({ ...l, device_id: deviceId }));
    const { error } = await supabase.from('logs').insert(logsWithDevice);
    if (!error) {
      console.log('[SUPABASE] logs reconciliation successful.');
      cacheManager.clearOfflineLogs();
    } else {
      console.error('[SUPABASE] logs reconciliation failed:', error.message);
    }
  }
}

function startHeartbeat() {
  const ping = async () => {
    try {
      const deviceId = getDeviceId();
      const deviceName = getDeviceName();

      const { error } = await supabase
        .from('device_status')
        .upsert({ 
          id: deviceId, 
          device_id: deviceId,
          device_name: deviceName,
          current_status: 'ONLINE', 
          last_seen: new Date().toISOString() 
        });

      if (error) {
        console.error('[SUPABASE] Heartbeat error (Offline?):', error.message);
        global.connectivityState = 'Offline';
        if (global.updateTrayTooltip) global.updateTrayTooltip();
      } else {
        const wasOffline = global.connectivityState !== 'Connected to Supabase';
        global.connectivityState = 'Connected to Supabase';
        if (global.updateTrayTooltip) global.updateTrayTooltip();
        // Connection alive, try resolving offline queue
        await reconcileCache();
        
        if (wasOffline) {
          await recoverPendingCommands();
        }
      }
    } catch (err) {
      console.error('[SUPABASE] Heartbeat exception (Network drop?):', err.message);
      global.connectivityState = 'Offline';
      if (global.updateTrayTooltip) global.updateTrayTooltip();
    }
  };

  ping(); // Fire immediately on startup
  setInterval(ping, 30000);
}

function startCommandListener() {
  const deviceId = getDeviceId();
  supabase
    .channel(`public:commands:${deviceId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'commands',
        filter: 'status=eq.pending'
      },
      (payload) => {
        if (!payload.new.device_id || payload.new.device_id === deviceId || payload.new.device_id === 'home_desktop_agent') {
          console.log(`[SUPABASE] Received remote command payload for ${deviceId}. Initiating process...`);
          processCommandById(payload.new.id, 'realtime');
        }
      }
    )
    .subscribe((status) => {
      console.log(`[SUPABASE] Command listener subscription status: ${status}`);
      if (status === 'SUBSCRIBED') {
        recoverPendingCommands();
      }
    });

  supabase
    .channel(`public:skip_days:${deviceId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'skip_days' },
      async (payload) => {
        if (!payload.new || !payload.new.device_id || payload.new.device_id === deviceId) {
          console.log(`[SUPABASE] skip_days table changed (${payload.eventType}). Re-evaluating schedule...`);
          const scheduler = require('./scheduler');
          await scheduler.init(supabase);
          if (global.updateTrayTooltip) global.updateTrayTooltip();
        }
      }
    )
    .subscribe((status) => {
      console.log(`[SUPABASE] skip_days listener subscription status: ${status}`);
    });
}

async function initSupabase() {
  console.log('[SUPABASE] Initializing Supabase client with Multi-Device support...');
  
  const config = cacheManager.getDeviceConfig();
  if (config.supabase_email && config.supabase_password) {
    console.log(`[SUPABASE] Authenticating as ${config.supabase_email}...`);
    const { data, error } = await supabase.auth.signInWithPassword({
      email: config.supabase_email,
      password: config.supabase_password
    });
    
    if (error) {
      console.error('[SUPABASE] Authentication failed! Check your credentials in Settings.', error.message);
    } else {
      console.log('[SUPABASE] Authentication successful.');
    }
  } else {
    console.warn('[SUPABASE] No Supabase email/password configured. Assuming anonymous/service role, but RLS may block access.');
  }

  startHeartbeat();
  startCommandListener();
}

module.exports = {
  supabase,
  initSupabase,
  getDeviceId,
  getDeviceName,
  __test: {
    processCommandById,
    recoverPendingCommands,
    setRuntimeDependenciesForTest,
    resetRuntimeDependencies
  }
};
