require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { executeClockAction, manualFetchProof } = require('./automation'); // Import Playwright logic

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn('Missing Supabase URL or Service Role Key in environment variables.');
}

const supabase = createClient(supabaseUrl || 'https://placeholder.supabase.co', supabaseKey || 'placeholder');

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
        console.error('[SUPABASE] Heartbeat error:', error.message);
      } else {
        console.log(`[SUPABASE] Heartbeat pulse sent at ${new Date().toISOString()}`);
      }
    } catch (err) {
      console.error('[SUPABASE] Heartbeat exception:', err);
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
        
        // Immediately update status to 'processing'
        const { error } = await supabase
          .from('commands')
          .update({ status: 'processing' })
          .eq('id', id);

        if (error) {
          console.error(`[SUPABASE] Failed to update command ${id} to processing:`, error.message);
          return;
        }

        // Trigger Playwright Sequence
        if (action === 'clock_in' || action === 'clock_out') {
          try {
            await executeClockAction(action, supabase);
            
            // Mark complete on success
            await supabase
              .from('commands')
              .update({ status: 'completed' })
              .eq('id', id);
            console.log(`[SUPABASE] Command ${id} marked as completed.`);

          } catch (execError) {
            // Mark failed on error
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
  console.log('[SUPABASE] Initializing Supabase client...');
  startHeartbeat();
  startCommandListener();
}

module.exports = { supabase, initSupabase };
