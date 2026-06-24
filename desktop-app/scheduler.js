const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { executeClockAction } = require('./automation');

const SCHEDULE_FILE = path.join(__dirname, 'schedule.json');

// Helper to get random minute between min and max
function getRandomMinute(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Generate today's schedule
async function generateDailySchedule(supabase) {
  const today = new Date();
  const dateString = today.toISOString().split('T')[0];
  
  // 1. Check if today is skipped
  const { data, error } = await supabase
      .from('config')
      .select('*')
      .eq('key', 'skip_days')
      .single();
      
  let skipDays = [];
  if (data && data.value) {
      skipDays = Array.isArray(data.value) ? data.value : [];
  }
  
  const dayOfWeek = today.getDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) {
      console.log(`[SCHEDULER] Today (${dateString}) is a Weekend. No automation scheduled.`);
      const skipData = { date: dateString, skipped: true };
      fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(skipData, null, 2));
      try {
        await supabase.from('config').upsert({ key: 'todays_schedule', value: skipData });
      } catch (e) {}
      return;
  }
  
  if (skipDays.includes(dateString)) {
      console.log(`[SCHEDULER] Today (${dateString}) is a Skip Day. No automation scheduled.`);
      const skipData = { date: dateString, skipped: true };
      fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(skipData, null, 2));
      try {
        await supabase.from('config').upsert({ key: 'todays_schedule', value: skipData });
      } catch (e) {}
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
      date: dateString,
      skipped: false,
      clockInTarget: inTimeStr,
      clockOutTarget: outTimeStr,
      clockInDone: false,
      clockOutDone: false
  };
  
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(scheduleData, null, 2));
  console.log(`[SCHEDULER] Generated schedule for ${dateString}: IN=${inTimeStr}, OUT=${outTimeStr}`);
  
  try {
    await supabase.from('config').upsert({
      key: 'todays_schedule',
      value: {
        date: scheduleData.date,
        clockInTarget: scheduleData.clockInTarget,
        clockOutTarget: scheduleData.clockOutTarget,
        skipped: scheduleData.skipped
      }
    });
    console.log('[SCHEDULER] Synced today\'s schedule to Supabase.');
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
  
  const [inH, inM] = scheduleData.clockInTarget.split(':');
  const [outH, outM] = scheduleData.clockOutTarget.split(':');
  
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
  
  if (!scheduleData.clockInDone) {
    clockInTask = cron.schedule(`${cronInM} ${cronInH} * * *`, async () => {
      console.log('[SCHEDULER] Triggering scheduled Clock IN...');
      try {
        await executeClockAction('clock_in', supabase);
        scheduleData.clockInDone = true;
        fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(scheduleData, null, 2));
      } catch (err) {
        console.error('[SCHEDULER] Scheduled Clock IN failed:', err.message);
      }
    });
  }
  
  if (!scheduleData.clockOutDone) {
    clockOutTask = cron.schedule(`${cronOutM} ${cronOutH} * * *`, async () => {
      console.log('[SCHEDULER] Triggering scheduled Clock OUT...');
      try {
        await executeClockAction('clock_out', supabase);
        scheduleData.clockOutDone = true;
        fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(scheduleData, null, 2));
      } catch (err) {
        console.error('[SCHEDULER] Scheduled Clock OUT failed:', err.message);
      }
    });
  }
}

// Missed action recovery
async function checkMissedActions(supabase) {
  if (!fs.existsSync(SCHEDULE_FILE)) return;
  
  const scheduleData = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
  const today = new Date();
  const dateString = today.toISOString().split('T')[0];
  
  if (scheduleData.date !== dateString || scheduleData.skipped) return;
  
  const now = Date.now();
  
  const [inH, inM] = scheduleData.clockInTarget.split(':').map(Number);
  const targetInTime = new Date(today);
  targetInTime.setHours(inH, inM, 0, 0);
  
  const [outH, outM] = scheduleData.clockOutTarget.split(':').map(Number);
  const targetOutTime = new Date(today);
  targetOutTime.setHours(outH, outM, 0, 0);
  
  const gracePeriodMs = 300000; // 5 minutes
  
  // 5 minute grace period check
  if (!scheduleData.clockInDone && now >= targetInTime.getTime() && (now - targetInTime.getTime()) <= gracePeriodMs) {
    console.log('[SCHEDULER] RECOVERY: Missed Clock IN! Triggering now within 5-min grace period...');
    try {
      await executeClockAction('clock_in', supabase);
      scheduleData.clockInDone = true;
      fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(scheduleData, null, 2));
    } catch (err) {
      console.error('[SCHEDULER] Recovery Clock IN failed:', err.message);
    }
  }
  
  if (!scheduleData.clockOutDone && now >= targetOutTime.getTime() && (now - targetOutTime.getTime()) <= gracePeriodMs) {
    console.log('[SCHEDULER] RECOVERY: Missed Clock OUT! Triggering now within 5-min grace period...');
    try {
      await executeClockAction('clock_out', supabase);
      scheduleData.clockOutDone = true;
      fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(scheduleData, null, 2));
    } catch (err) {
      console.error('[SCHEDULER] Recovery Clock OUT failed:', err.message);
    }
  }
}

async function init(supabase) {
  const today = new Date();
  const dateString = today.toISOString().split('T')[0];
  
  let needsNewSchedule = true;
  if (fs.existsSync(SCHEDULE_FILE)) {
    const scheduleData = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
    if (scheduleData && scheduleData.date === dateString) {
      console.log(`[SCHEDULER] Loaded existing schedule for today (${dateString}).`);
      
      try {
        await supabase.from('config').upsert({
          key: 'todays_schedule',
          value: {
            date: scheduleData.date,
            clockInTarget: scheduleData.clockInTarget,
            clockOutTarget: scheduleData.clockOutTarget,
            skipped: scheduleData.skipped
          }
        });
      } catch (err) {}

      scheduleCronJobs(scheduleData, supabase);
      return;
    }
  }
  
  if (needsNewSchedule) {
    await generateDailySchedule(supabase);
  }
  
  // Check missed actions immediately
  await checkMissedActions(supabase);
  
  // Schedule the midnight job generator
  cron.schedule('0 0 * * *', () => {
    generateDailySchedule(supabase);
  });
}

module.exports = { init };
