const cron = require('node-cron');
const { executeClockAction } = require('./automation');
const cacheManager = require('./cache-manager');

// Helper to get random minute between min and max
function getRandomMinute(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Generate today's schedule
async function generateDailySchedule(supabase) {
  const today = new Date();
  const dateString = today.toISOString().split('T')[0];
  const dayOfWeek = today.getDay();
  const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
  
  let isSkipDay = false;
  let supabaseOnline = true;

  try {
    const { data: skipData, error } = await supabase
        .from('skip_days')
        .select('date')
        .eq('date', dateString)
        .maybeSingle();
        
    if (error) throw error;
    isSkipDay = !!skipData;
  } catch (err) {
    console.error('[SCHEDULER] Supabase offline during schedule generation! Falling back to local cache.');
    supabaseOnline = false;
    const cache = cacheManager.readCache();
    isSkipDay = cache.skip_days.includes(dateString);
  }

  if (isWeekend || isSkipDay) {
      console.log(`[SCHEDULER] Today (${dateString}) is skipped (Weekend/Holiday). No automation scheduled.`);
      
      const payload = {
          last_schedule_date: dateString,
          skipped: true,
          scheduled_clock_in: null,
          scheduled_clock_out: null,
          clock_in_done: false,
          clock_out_done: false
      };

      if (supabaseOnline) {
          try {
              await supabase.from('system_config').upsert({ id: 1, ...payload });
              await supabase.from('logs').insert({ action: 'scheduler', status: 'skipped', message: `Automation skipped for ${dateString}` });
              cacheManager.mergeSystemConfig(payload, true);
          } catch(e) {
              cacheManager.mergeSystemConfig(payload, false);
              cacheManager.logOffline('scheduler', 'skipped', `Automation skipped for ${dateString}`);
          }
      } else {
          cacheManager.mergeSystemConfig(payload, false);
          cacheManager.logOffline('scheduler', 'skipped', `Automation skipped for ${dateString}`);
      }
      return;
  }
  
  // 2. Generate random times
  const inMinute = getRandomMinute(45, 50);
  const inTimeStr = `07:${inMinute.toString().padStart(2, '0')}`;
  
  const outMinute = getRandomMinute(5, 10);
  const outTimeStr = `17:${outMinute.toString().padStart(2, '0')}`;
  
  const scheduleData = {
      last_schedule_date: dateString,
      skipped: false,
      scheduled_clock_in: inTimeStr,
      scheduled_clock_out: outTimeStr,
      clock_in_done: false,
      clock_out_done: false
  };
  
  console.log(`[SCHEDULER] Generated schedule for ${dateString}: IN=${inTimeStr}, OUT=${outTimeStr}`);
  
  if (supabaseOnline) {
      try {
        await supabase.from('system_config').upsert({ id: 1, ...scheduleData });
        console.log('[SCHEDULER] Synced today\'s schedule to Supabase system_config.');
        cacheManager.mergeSystemConfig(scheduleData, true);
      } catch (err) {
        console.error('[SCHEDULER] Failed to sync schedule to Supabase:', err.message);
        cacheManager.mergeSystemConfig(scheduleData, false);
      }
  } else {
      console.log('[SCHEDULER] Wrote schedule strictly to local cache (synced=false).');
      cacheManager.mergeSystemConfig(scheduleData, false);
  }
  
  if (global.updateTrayTooltip) global.updateTrayTooltip();
  
  scheduleCronJobs(scheduleData, supabase);
}

// Global references to running cron tasks
let clockInTask = null;
let clockOutTask = null;

function scheduleCronJobs(scheduleData, supabase) {
  if (scheduleData.skipped) return;
  
  if (clockInTask) clockInTask.stop();
  if (clockOutTask) clockOutTask.stop();
  
  const [inH, inM] = scheduleData.scheduled_clock_in.split(':');
  const [outH, outM] = scheduleData.scheduled_clock_out.split(':');
  
  // Time shift logic: Shift cron trigger 1 minute early for pre-flight check
  const inTime = new Date();
  inTime.setHours(Number(inH), Number(inM), 0, 0);
  inTime.setMinutes(inTime.getMinutes() - 1);
  const cronInH = inTime.getHours();
  const cronInM = inTime.getMinutes();
  
  const outTime = new Date();
  outTime.setHours(Number(outH), Number(outM), 0, 0);
  outTime.setMinutes(outTime.getMinutes() - 1);
  const cronOutH = outTime.getHours();
  const cronOutM = outTime.getMinutes();
  
  if (!scheduleData.clock_in_done) {
    clockInTask = cron.schedule(`${cronInM} ${cronInH} * * *`, async () => {
      console.log('[SCHEDULER] Triggering scheduled Clock IN...');
      try {
        await executeClockAction('clock_in', supabase);
        try {
          await supabase.from('system_config').update({ clock_in_done: true }).eq('id', 1);
          cacheManager.mergeSystemConfig({ clock_in_done: true }, true);
        } catch (e) {
          cacheManager.mergeSystemConfig({ clock_in_done: true }, false);
        }
      } catch (err) {
        console.error('[SCHEDULER] Scheduled Clock IN failed:', err.message);
      }
    });
  }
  
  if (!scheduleData.clock_out_done) {
    clockOutTask = cron.schedule(`${cronOutM} ${cronOutH} * * *`, async () => {
      console.log('[SCHEDULER] Triggering scheduled Clock OUT...');
      try {
        await executeClockAction('clock_out', supabase);
        try {
          await supabase.from('system_config').update({ clock_out_done: true }).eq('id', 1);
          cacheManager.mergeSystemConfig({ clock_out_done: true }, true);
        } catch (e) {
          cacheManager.mergeSystemConfig({ clock_out_done: true }, false);
        }
      } catch (err) {
        console.error('[SCHEDULER] Scheduled Clock OUT failed:', err.message);
      }
    });
  }
}

// Missed action recovery
async function checkMissedActions(scheduleData, supabase) {
  if (!scheduleData || scheduleData.skipped) return;
  
  const today = new Date();
  const dateString = today.toISOString().split('T')[0];
  
  if (scheduleData.last_schedule_date !== dateString) return;
  
  const now = Date.now();
  
  const [inH, inM] = scheduleData.scheduled_clock_in.split(':').map(Number);
  const targetInTime = new Date(today);
  targetInTime.setHours(inH, inM, 0, 0);
  
  const [outH, outM] = scheduleData.scheduled_clock_out.split(':').map(Number);
  const targetOutTime = new Date(today);
  targetOutTime.setHours(outH, outM, 0, 0);
  
  const gracePeriodMs = 300000; // 5 minutes
  
  if (!scheduleData.clock_in_done && now >= targetInTime.getTime() && (now - targetInTime.getTime()) <= gracePeriodMs) {
    console.log('[SCHEDULER] RECOVERY: Missed Clock IN! Triggering now...');
    try {
      await executeClockAction('clock_in', supabase);
      try {
        await supabase.from('system_config').update({ clock_in_done: true }).eq('id', 1);
        cacheManager.mergeSystemConfig({ clock_in_done: true }, true);
      } catch (e) {
        cacheManager.mergeSystemConfig({ clock_in_done: true }, false);
      }
    } catch (err) {}
  }
  
  if (!scheduleData.clock_out_done && now >= targetOutTime.getTime() && (now - targetOutTime.getTime()) <= gracePeriodMs) {
    console.log('[SCHEDULER] RECOVERY: Missed Clock OUT! Triggering now...');
    try {
      await executeClockAction('clock_out', supabase);
      try {
        await supabase.from('system_config').update({ clock_out_done: true }).eq('id', 1);
        cacheManager.mergeSystemConfig({ clock_out_done: true }, true);
      } catch (e) {
        cacheManager.mergeSystemConfig({ clock_out_done: true }, false);
      }
    } catch (err) {}
  }
}

async function init(supabase) {
  const today = new Date();
  const dateString = today.toISOString().split('T')[0];
  
  let scheduleData = null;
  try {
    const { data, error } = await supabase
      .from('system_config')
      .select('*')
      .eq('id', 1)
      .maybeSingle();
      
    if (error) throw error;
    scheduleData = data;
    if (data) {
        cacheManager.mergeSystemConfig({
            last_schedule_date: data.last_schedule_date,
            skipped: data.skipped,
            scheduled_clock_in: data.scheduled_clock_in,
            scheduled_clock_out: data.scheduled_clock_out,
            clock_in_done: data.clock_in_done,
            clock_out_done: data.clock_out_done
        }, true);
    }
  } catch (err) {
    console.error(`[SCHEDULER] Supabase offline on boot! Reading from local cache.`);
    const cache = cacheManager.readCache();
    scheduleData = cache.system_config;
  }
  
  if (scheduleData && scheduleData.last_schedule_date === dateString) {
    console.log(`[SCHEDULER] Loaded existing schedule for today (${dateString}).`);
    scheduleCronJobs(scheduleData, supabase);
    await checkMissedActions(scheduleData, supabase);
  } else {
    console.log(`[SCHEDULER] No current schedule found for ${dateString}, generating new one...`);
    await generateDailySchedule(supabase);
  }
  
  cron.schedule('0 0 * * *', () => {
    generateDailySchedule(supabase);
  });
}

module.exports = { init };
