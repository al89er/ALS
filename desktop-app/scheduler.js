const cron = require('node-cron');
const { executeClockAction } = require('./automation');

// Helper to get random minute between min and max
function getRandomMinute(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Generate today's schedule
async function generateDailySchedule(supabase) {
  const today = new Date();
  const dateString = today.toISOString().split('T')[0];
  
  // 1. Check if today is skipped (using skip_days table)
  const { data: skipData } = await supabase
      .from('skip_days')
      .select('date')
      .eq('date', dateString)
      .maybeSingle();
      
  const dayOfWeek = today.getDay();
  const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
  const isSkipDay = !!skipData;

  if (isWeekend || isSkipDay) {
      console.log(`[SCHEDULER] Today (${dateString}) is skipped (Weekend/Holiday). No automation scheduled.`);
      await supabase.from('system_config').upsert({
          id: 1,
          last_schedule_date: dateString,
          skipped: true,
          scheduled_clock_in: null,
          scheduled_clock_out: null,
          clock_in_done: false,
          clock_out_done: false
      });
      await supabase.from('logs').insert({
          action: 'scheduler',
          status: 'skipped',
          message: `Automation skipped for ${dateString}`
      });
      return;
  }
  
  // 2. Generate random times
  // In: 07:45 - 07:50
  const inMinute = getRandomMinute(45, 50);
  const inTimeStr = `07:${inMinute.toString().padStart(2, '0')}`;
  
  // Out: 17:05 - 17:10
  const outMinute = getRandomMinute(5, 10);
  const outTimeStr = `17:${outMinute.toString().padStart(2, '0')}`;
  
  const scheduleData = {
      id: 1,
      last_schedule_date: dateString,
      skipped: false,
      scheduled_clock_in: inTimeStr,
      scheduled_clock_out: outTimeStr,
      clock_in_done: false,
      clock_out_done: false
  };
  
  console.log(`[SCHEDULER] Generated schedule for ${dateString}: IN=${inTimeStr}, OUT=${outTimeStr}`);
  
  try {
    await supabase.from('system_config').upsert(scheduleData);
    console.log('[SCHEDULER] Synced today\\'s schedule to Supabase system_config.');
  } catch (err) {
    console.error('[SCHEDULER] Failed to sync schedule to Supabase:', err.message);
  }
  
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
        await supabase.from('system_config').update({ clock_in_done: true }).eq('id', 1);
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
        await supabase.from('system_config').update({ clock_out_done: true }).eq('id', 1);
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
  
  // 5 minute grace period check
  if (!scheduleData.clock_in_done && now >= targetInTime.getTime() && (now - targetInTime.getTime()) <= gracePeriodMs) {
    console.log('[SCHEDULER] RECOVERY: Missed Clock IN! Triggering now within 5-min grace period...');
    try {
      await executeClockAction('clock_in', supabase);
      await supabase.from('system_config').update({ clock_in_done: true }).eq('id', 1);
    } catch (err) {
      console.error('[SCHEDULER] Recovery Clock IN failed:', err.message);
    }
  }
  
  if (!scheduleData.clock_out_done && now >= targetOutTime.getTime() && (now - targetOutTime.getTime()) <= gracePeriodMs) {
    console.log('[SCHEDULER] RECOVERY: Missed Clock OUT! Triggering now within 5-min grace period...');
    try {
      await executeClockAction('clock_out', supabase);
      await supabase.from('system_config').update({ clock_out_done: true }).eq('id', 1);
    } catch (err) {
      console.error('[SCHEDULER] Recovery Clock OUT failed:', err.message);
    }
  }
}

async function init(supabase) {
  const today = new Date();
  const dateString = today.toISOString().split('T')[0];
  
  // Fetch config from Supabase natively
  const { data: scheduleData } = await supabase
    .from('system_config')
    .select('*')
    .eq('id', 1)
    .maybeSingle();
  
  if (scheduleData && scheduleData.last_schedule_date === dateString) {
    console.log(`[SCHEDULER] Loaded existing schedule for today (${dateString}) from Supabase.`);
    scheduleCronJobs(scheduleData, supabase);
    await checkMissedActions(scheduleData, supabase);
  } else {
    console.log(`[SCHEDULER] No current schedule found for ${dateString}, generating new one...`);
    await generateDailySchedule(supabase);
  }
  
  // Schedule the midnight job generator
  cron.schedule('0 0 * * *', () => {
    generateDailySchedule(supabase);
  });
}

module.exports = { init };
