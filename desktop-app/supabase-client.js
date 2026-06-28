const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { createClient } = require('@supabase/supabase-js');
const { executeClockAction, manualFetchProof } = require('./automation'); // Import Playwright logic
const cacheManager = require('./cache-manager');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn('Missing Supabase URL or Service Role Key in environment variables.');
}

const supabase = createClient(supabaseUrl || 'https://placeholder.supabase.co', supabaseKey || 'placeholder');

async function reconcileCache() {
  const cache = cacheManager.readCache();
  
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
    const payload = { ...cache.daily_schedule };
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
    const { error } = await supabase.from('logs').insert(cache.offline_logs);
    if (!error) {
      console.log('[SUPABASE] logs reconciliation successful.');
      cacheManager.clearOfflineLogs();
    } else {
      console.error('[SUPABASE] logs reconciliation failed:', error.message);
    }
  }
}

function startHeartbeat() {
  setInterval(async () => {
    try {
      const { error } = await supabase
        .from('device_status')
        .upsert({ 
          id: 'home_desktop_agent', 
          current_status: 'ONLINE', 
          last_seen: new Date().toISOString() 
        });

      if (error) {
        console.error('[SUPABASE] Heartbeat error (Offline?):', error.message);
        global.connectivityState = 'Offline';
        if (global.updateTrayTooltip) global.updateTrayTooltip();
      } else {
        global.connectivityState = 'Connected to Supabase';
        if (global.updateTrayTooltip) global.updateTrayTooltip();
        // Connection alive, try resolving offline queue
        await reconcileCache();
      }
    } catch (err) {
      console.error('[SUPABASE] Heartbeat exception (Network drop?):', err.message);
      global.connectivityState = 'Offline';
      if (global.updateTrayTooltip) global.updateTrayTooltip();
    }
  }, 30000);
}

function startCommandListener() {
  supabase
    .channel('public:commands')
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'commands',
        filter: 'status=eq.pending'
      },
      async (payload) => {
        const { id, action } = payload.new;
        console.log(`[SUPABASE] Received remote command: ${action}. Routing to Playwright...`);
        
        const { error } = await supabase
          .from('commands')
          .update({ status: 'processing' })
          .eq('id', id);

        if (error) {
          console.error(`[SUPABASE] Failed to update command ${id} to processing:`, error.message);
          return;
        }

        if (action === 'clock_in' || action === 'clock_out') {
          try {
            await executeClockAction(action, supabase);
            
            await supabase
              .from('commands')
              .update({ status: 'completed' })
              .eq('id', id);
            console.log(`[SUPABASE] Command ${id} marked as completed.`);

          } catch (execError) {
            await supabase
              .from('commands')
              .update({ status: 'failed' })
              .eq('id', id);
            console.error(`[SUPABASE] Command ${id} marked as failed due to Playwright error.`);
          }
        } else if (action === 'manual_proof_sync') {
          try {
            await manualFetchProof(supabase);
            
            await supabase
              .from('commands')
              .update({ status: 'completed' })
              .eq('id', id);
            console.log(`[SUPABASE] Command ${id} (manual proof) marked as completed.`);
          } catch (execError) {
            await supabase
              .from('commands')
              .update({ status: 'failed' })
              .eq('id', id);
            console.error(`[SUPABASE] Command ${id} marked as failed due to Playwright error.`);
          }
        } else {
          console.warn(`[SUPABASE] Unknown action: ${action}`);
        }
      }
    )
    .subscribe((status) => {
      console.log(`[SUPABASE] Command listener subscription status: ${status}`);
    });
}

function initSupabase() {
  console.log('[SUPABASE] Initializing Supabase client with Offline Resilience...');
  startHeartbeat();
  startCommandListener();
}

module.exports = { supabase, initSupabase };
