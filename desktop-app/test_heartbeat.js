const { initSupabase, supabase } = require('./supabase-client');

async function testStatus() {
    console.log("Checking if supabase URL and key are loaded...");
    // Force a heartbeat right now
    const now = new Date().toISOString();
    console.log("Attempting to upsert device_status with:", now);
    const { data, error } = await supabase
        .from('device_status')
        .upsert({ 
          id: 'home_desktop_agent', 
          current_status: 'ONLINE', 
          last_seen: now
        })
        .select();

    if (error) {
        console.error("UPSERT ERROR:", JSON.stringify(error, null, 2));
    } else {
        console.log("UPSERT SUCCESS:", data);
    }
}

testStatus();
