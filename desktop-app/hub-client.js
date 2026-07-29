const { createClient } = require('@supabase/supabase-js');
const { executeClockAction, manualFetchProof } = require('./automation');
const cacheManager = require('./cache-manager');

let isExecuting = false;
const commandQueue = [];
const activeClients = new Map();

async function processQueue() {
  if (isExecuting) return;
  isExecuting = true;
  while (commandQueue.length > 0) {
    const task = commandQueue.shift();
    try {
      await task();
    } catch (err) {
      console.error('[HUB] Execution error:', err);
    }
  }
  isExecuting = false;
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

  // Clear existing listeners
  for (const [deviceId, client] of activeClients.entries()) {
    client.removeAllChannels();
  }
  activeClients.clear();

  for (const account of accounts) {
    if (!account.supabase_email || !account.supabase_password) continue;

    console.log(`[HUB] Initializing isolated client for ${account.device_id}...`);
    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: true,
        detectSessionInUrl: false
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

function startHubHeartbeat(supabase, account) {
  const ping = async () => {
    try {
      const { error } = await supabase
        .from('device_status')
        .upsert({ 
          id: account.device_id, 
          device_id: account.device_id,
          device_name: account.device_name || 'Hub Account',
          current_status: 'ONLINE (HUB)', 
          last_seen: new Date().toISOString() 
        });
      if (error) console.error(`[HUB] Heartbeat failed for ${account.device_id}:`, error.message);
    } catch (err) {
      // Ignore network drops
    }
  };

  ping();
  setInterval(ping, 30000);
}

function startHubCommandListener(supabase, account) {
  const channel = supabase.channel(`public:commands:${account.device_id}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'commands', filter: `device_id=eq.${account.device_id}` },
      async (payload) => {
        const cmd = payload.new;
        console.log(`[HUB] Received command for ${account.device_id}: ${cmd.action}`);
        
        commandQueue.push(async () => {
          try {
            await supabase.from('commands').update({ status: 'processing', updated_at: new Date().toISOString() }).eq('id', cmd.id);
            
            if (cmd.action === 'clock_in' || cmd.action === 'clock_out') {
              await executeClockAction(cmd.action, supabase, { source: 'hub_manual', hubAccount: account });
            } else if (cmd.action === 'manual_proof_sync') {
              await manualFetchProof(supabase, { source: 'hub_manual', hubAccount: account });
            }
            
            await supabase.from('commands').update({ status: 'completed', updated_at: new Date().toISOString() }).eq('id', cmd.id);
          } catch (err) {
            console.error(`[HUB] Command execution failed for ${account.device_id}:`, err);
            await supabase.from('commands').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', cmd.id);
          }
        });
        
        processQueue();
      }
    )
    .subscribe();
}

async function getHubAccountStatus(deviceId) {
  const client = activeClients.get(deviceId);
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

module.exports = {
  initHubAccounts,
  getHubAccountStatus
};
