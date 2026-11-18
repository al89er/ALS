const path = require('path');
if (process.env.NODE_ENV !== 'test') {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
}
const { createClient } = require('@supabase/supabase-js');
const { executeClockAction, manualFetchProof } = require('./automation'); // Import Playwright logic
const {
  DEFAULT_SUPABASE_URL,
  resolveSupabasePublishableKey
} = require('./supabase-config');

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
  const url = config.supabase_url || process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const key = resolveSupabasePublishableKey({
    runtimeKey: process.env.SUPABASE_PUBLISHABLE_KEY,
    compatibilityKey: process.env.SUPABASE_ANON_KEY,
    savedKey: config.supabase_key
  });
  return { url, key };
}

const activeConfig = getEffectiveSupabaseConfig();
if (!activeConfig.url) {
  console.warn('Missing Supabase URL in environment/settings.');
}

const supabase = createClient(activeConfig.url, activeConfig.key);

const PENDING_COMMAND_MAX_AGE_MS = 15 * 60 * 1000;
const HOME_DEVICE_ID = 'home_desktop_agent';
let isRecovering = false;
let processingPromise = Promise.resolve();
let schedulingChannel = null;
let commandChannel = null;
let heartbeatTimer = null;
let isAuthenticated = false;
let authPromise = null;
let lastAuthError = null;

function isHomeAutoScheduleAgent() {
  const config = cacheManager.getDeviceConfig ? cacheManager.getDeviceConfig() : {};
  const edition = (
    process.env.ALS_EDITION ||
    config.edition ||
    (cacheManager.getAppEdition ? cacheManager.getAppEdition() : 'full')
  ).toLowerCase();
  return getDeviceId() === HOME_DEVICE_ID && edition === 'full';
}

async function processCommandById(commandId, source = 'unknown') {
  return new Promise((resolve) => {
    processingPromise = processingPromise.then(async () => {
      try {
        const deviceId = getDeviceId();
        let claimQuery = supabase
          .from('commands')
          .update({ status: 'processing' })
          .eq('id', commandId)
          .eq('status', 'pending');

        if (deviceId === 'home_desktop_agent') {
          claimQuery = claimQuery.or(`device_id.eq.${deviceId},device_id.is.null,device_id.eq.home_desktop_agent`);
        } else {
          claimQuery = claimQuery.eq('device_id', deviceId);
        }

        const { data: command, error: claimError } = await claimQuery
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
        const validActions = ['clock_in', 'clock_out', 'ot_in', 'ot_out', 'manual_proof_sync'];
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
          if (action === 'clock_in' || action === 'clock_out' || action === 'ot_in' || action === 'ot_out') {
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

          if (isHomeAutoScheduleAgent() && (action === 'clock_in' || action === 'clock_out' || action === 'manual_proof_sync')) {
            try {
              const scheduler = require('./scheduler');
              if (typeof scheduler.reconcileSchedule === 'function') {
                await scheduler.reconcileSchedule(supabase, {
                  triggerSource: `command_${action}`,
                  force: true
                });
              }
            } catch (recErr) {
              console.warn('[SUPABASE] Post-command schedule reconciliation warning:', recErr.message);
            }
          }
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

    // Preserve any existing cloud completed flags before upserting offline state
    try {
      const { data: existingCloud } = await supabase
        .from('daily_schedules')
        .select('clock_in_done, clock_out_done')
        .eq('date', payload.date)
        .eq('device_id', deviceId)
        .maybeSingle();
      if (existingCloud) {
        if (existingCloud.clock_in_done === true) payload.clock_in_done = true;
        if (existingCloud.clock_out_done === true) payload.clock_out_done = true;
      }
    } catch (_) {}

    let { error } = await supabase.from('daily_schedules').upsert(payload, { onConflict: 'date, device_id' });
    if (error && /column|does not exist|PGRST/i.test(error.message || '')) {
      const legacyPayload = {
        date: payload.date,
        device_id: deviceId,
        skipped: !!payload.skipped,
        scheduled_clock_in: payload.scheduled_clock_in || null,
        scheduled_clock_out: payload.scheduled_clock_out || null,
        clock_in_done: !!payload.clock_in_done,
        clock_out_done: !!payload.clock_out_done
      };
      ({ error } = await supabase.from('daily_schedules').upsert(legacyPayload));
    }
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
    }, { onConflict: 'date, device_id' });
    
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

async function checkAndReconcileScheduleRevision(wasOffline = false) {
  if (!isHomeAutoScheduleAgent()) return null;
  const scheduler = require('./scheduler');
  const snap = typeof scheduler.getDiagnosticsSnapshot === 'function'
    ? scheduler.getDiagnosticsSnapshot()
    : (typeof scheduler.getRuntimeSnapshot === 'function' ? scheduler.getRuntimeSnapshot() : { currentAppliedRevision: 0 });

  const todayStr = new Date().toLocaleDateString('en-CA');
  let remoteRevision = null;
  let remoteAppliedRevision = null;
  try {
    const { data, error } = await supabase
      .from('schedule_policy_state')
      .select('revision, applied_revision')
      .eq('device_id', HOME_DEVICE_ID)
      .maybeSingle();

    if (!error && data && data.revision !== undefined) {
      remoteRevision = Number(data.revision) || 0;
      remoteAppliedRevision = Number(data.applied_revision || 0);
      if (typeof scheduler.notifyIncomingRevision === 'function') {
        scheduler.notifyIncomingRevision(remoteRevision);
      }
    }
  } catch (_) {}

  const needsHealthRecovery =
    !snap.initialized ||
    (snap.healthStatus && snap.healthStatus !== 'healthy' && snap.healthStatus !== 'disabled') ||
    (snap.todayDate && snap.lastEvaluatedDate && snap.lastEvaluatedDate !== todayStr);

  const remoteAckPending = remoteRevision !== null && remoteAppliedRevision !== null && remoteAppliedRevision < remoteRevision;

  if (wasOffline || needsHealthRecovery || remoteAckPending || (remoteRevision !== null && remoteRevision > (snap.currentAppliedRevision || 0))) {
    const triggerSource = wasOffline
      ? 'heartbeat_reconnect'
      : (needsHealthRecovery ? 'heartbeat_health_recovery' : 'heartbeat_revision_poll');
    console.log(`[SUPABASE] Triggering schedule reconciliation (source=${triggerSource}, remoteRev=${remoteRevision}, appliedRev=${snap.currentAppliedRevision}, health=${snap.healthStatus || 'unknown'})...`);
    return await scheduler.reconcileSchedule(supabase, {
      triggerSource,
      eventRevision: remoteRevision,
      force: true,
      checkMissed: wasOffline || needsHealthRecovery
    });
  }
  return null;
}

async function ensureAuthenticatedSession() {
  if (isAuthenticated) return { authenticated: true, justAuthenticated: false };
  const config = cacheManager.getDeviceConfig ? cacheManager.getDeviceConfig() : {};
  if (!config.supabase_email || !config.supabase_password) {
    return { authenticated: false, justAuthenticated: false, skipped: true };
  }
  if (authPromise) return authPromise;

  authPromise = (async () => {
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: config.supabase_email,
        password: config.supabase_password
      });
      if (error) {
        lastAuthError = error.message;
        console.error('[SUPABASE] Authentication failed:', error.message);
        return { authenticated: false, justAuthenticated: false, error: error.message };
      }
      isAuthenticated = true;
      lastAuthError = null;
      console.log('[SUPABASE] Authentication successful.');
      if (data && data.session && data.session.access_token && supabase.realtime && typeof supabase.realtime.setAuth === 'function') {
        try { supabase.realtime.setAuth(data.session.access_token); } catch (_) {}
      }
      return { authenticated: true, justAuthenticated: true };
    } catch (err) {
      lastAuthError = err.message;
      console.error('[SUPABASE] Authentication exception:', err.message);
      return { authenticated: false, justAuthenticated: false, error: err.message };
    } finally {
      authPromise = null;
    }
  })();

  return authPromise;
}

async function pingHeartbeatOnce() {
  try {
    const authRes = await ensureAuthenticatedSession();
    const justAuthenticated = Boolean(authRes && authRes.justAuthenticated);

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
      return { online: false, error: error.message };
    }

    const wasOffline = global.connectivityState !== 'Connected to Supabase';
    global.connectivityState = 'Connected to Supabase';
    if (global.updateTrayTooltip) global.updateTrayTooltip();

    // Connection alive, try resolving offline queue
    await reconcileCache();

    if (wasOffline || justAuthenticated) {
      await recoverPendingCommands();
    }

    // Self-heal degraded realtime listeners after sleep / network drops
    if (commandChannel && (commandChannel.state === 'closed' || commandChannel.state === 'errored')) {
      console.log('[SUPABASE] Re-subscribing degraded command listener channel...');
      startCommandListener();
    } else if (schedulingChannel && (schedulingChannel.state === 'closed' || schedulingChannel.state === 'errored')) {
      console.log('[SUPABASE] Re-subscribing degraded scheduling listener channel...');
      startCommandListener();
    }

    await checkAndReconcileScheduleRevision(wasOffline || justAuthenticated);
    return { online: true, wasOffline, justAuthenticated };
  } catch (err) {
    console.error('[SUPABASE] Heartbeat exception (Network drop?):', err.message);
    global.connectivityState = 'Offline';
    if (global.updateTrayTooltip) global.updateTrayTooltip();
    return { online: false, error: err.message };
  }
}

function startHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }
  pingHeartbeatOnce(); // Fire immediately on startup
  heartbeatTimer = setInterval(pingHeartbeatOnce, 30000);
  if (typeof heartbeatTimer.unref === 'function') {
    heartbeatTimer.unref();
  }
}

async function handleScheduleRealtimeEvent(tableName, payload) {
  if (!isHomeAutoScheduleAgent()) return null;
  const deviceId = getDeviceId();
  const row = (payload && (payload.new || payload.old)) || {};
  if (row.device_id && row.device_id !== deviceId && row.device_id !== HOME_DEVICE_ID) {
    return null;
  }

  // Ignore self-acknowledgement updates on schedule_policy_state unless revision increased
  const scheduler = require('./scheduler');
  const snap = typeof scheduler.getRuntimeSnapshot === 'function'
    ? scheduler.getRuntimeSnapshot()
    : { currentAppliedRevision: 0 };

  if (tableName === 'schedule_policy_state' && payload && payload.new) {
    const incomingRev = Number(payload.new.revision) || 0;
    const appliedRev = Number(payload.new.applied_revision) || 0;
    if (incomingRev <= snap.currentAppliedRevision && appliedRev >= incomingRev) {
      return null;
    }
    if (typeof scheduler.notifyIncomingRevision === 'function') {
      scheduler.notifyIncomingRevision(incomingRev);
    }
    console.log(`[SUPABASE] Realtime schedule_policy_state rev #${incomingRev} detected. Reconciling...`);
    return await scheduler.reconcileSchedule(supabase, {
      triggerSource: `realtime:${tableName}`,
      eventRevision: incomingRev,
      force: true
    });
  }

  console.log(`[SUPABASE] ${tableName} changed (${payload ? payload.eventType : 'change'}). Reconciling schedule...`);
  return await scheduler.reconcileSchedule(supabase, {
    triggerSource: `realtime:${tableName}`,
    force: true
  });
}

function startCommandListener() {
  const deviceId = getDeviceId();

  if (commandChannel && typeof supabase.removeChannel === 'function') {
    try { supabase.removeChannel(commandChannel); } catch (_) {}
  }
  if (schedulingChannel && typeof supabase.removeChannel === 'function') {
    try { supabase.removeChannel(schedulingChannel); } catch (_) {}
  }

  commandChannel = supabase
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
        if (!payload.new.device_id || payload.new.device_id === deviceId || payload.new.device_id === HOME_DEVICE_ID) {
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

  if (isHomeAutoScheduleAgent()) {
    schedulingChannel = supabase
      .channel(`public:scheduling:${deviceId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'schedule_policy_state' },
        (payload) => handleScheduleRealtimeEvent('schedule_policy_state', payload)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'schedule_date_overrides' },
        (payload) => handleScheduleRealtimeEvent('schedule_date_overrides', payload)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'schedule_recurring_rules' },
        (payload) => handleScheduleRealtimeEvent('schedule_recurring_rules', payload)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'schedule_holidays' },
        (payload) => handleScheduleRealtimeEvent('schedule_holidays', payload)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'skip_days' },
        (payload) => handleScheduleRealtimeEvent('skip_days', payload)
      )
      .subscribe((status) => {
        console.log(`[SUPABASE] Scheduling policy listener subscription status: ${status}`);
        if (status === 'SUBSCRIBED') {
          const scheduler = require('./scheduler');
          scheduler.reconcileSchedule(supabase, {
            triggerSource: 'realtime_subscribed',
            force: true
          });
        }
      });
  } else {
    schedulingChannel = null;
  }
}

async function initSupabase() {
  console.log('[SUPABASE] Initializing Supabase client with Multi-Device support...');

  if (supabase.auth && typeof supabase.auth.onAuthStateChange === 'function') {
    supabase.auth.onAuthStateChange((event, session) => {
      if (session && session.access_token) {
        isAuthenticated = true;
        if (supabase.realtime && typeof supabase.realtime.setAuth === 'function') {
          try {
            supabase.realtime.setAuth(session.access_token);
          } catch (authErr) {
            console.warn('[SUPABASE] Failed to sync realtime auth token:', authErr.message);
          }
        }
      }
    });
  }

  const config = cacheManager.getDeviceConfig();
  if (config.supabase_email && config.supabase_password) {
    console.log(`[SUPABASE] Authenticating as ${config.supabase_email}...`);
    await ensureAuthenticatedSession();
  } else {
    console.warn('[SUPABASE] No Supabase email/password configured. Unauthenticated requests may be blocked by RLS.');
  }

  startHeartbeat();
  startCommandListener();
  return { authenticated: isAuthenticated, lastAuthError };
}

const VERSION = '1.7.2';

module.exports = {
  VERSION,
  supabase,
  initSupabase,
  getDeviceId,
  getDeviceName,
  isHomeAutoScheduleAgent,
  __test: {
    processCommandById,
    recoverPendingCommands,
    reconcileCache,
    pingHeartbeatOnce,
    ensureAuthenticatedSession,
    checkAndReconcileScheduleRevision,
    handleScheduleRealtimeEvent,
    startCommandListener,
    setRuntimeDependenciesForTest,
    resetRuntimeDependencies,
    resetAuthStateForTest: () => {
      isAuthenticated = false;
      authPromise = null;
      lastAuthError = null;
    }
  }
};
