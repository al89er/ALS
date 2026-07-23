const cron = require('node-cron');
const { executeClockAction } = require('./automation');
const cacheManager = require('./cache-manager');

// Helper to get random minute between min and max
function getRandomMinute(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function buildLocalTargetDate(dateString, timeString) {
  const [year, month, day] = dateString.split('-').map(Number);
  const [hour, minute] = timeString.split(':').map(Number);
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

// Generate today's schedule
async function generateDailySchedule(supabase) {
  const today = new Date();
  const dateString = today.toLocaleDateString('en-CA');
  const dayOfWeek = today.getDay();
  const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
  
  let isSkipDay = false;
  let supabaseOnline = true;
  let deviceId = 'home_desktop_agent';
  try {
    const { getDeviceId } = require('./supabase-client');
    if (typeof getDeviceId === 'function') deviceId = getDeviceId();
  } catch (e) {}

  try {
    const { data: allSkips } = await supabase
      .from('skip_days')
      .select('date, device_id');
      
    if (allSkips && Array.isArray(allSkips)) {
      const filteredSkips = allSkips.filter(s => !s.device_id || s.device_id === deviceId || s.device_id === 'home_desktop_agent');
      cacheManager.updateSkipDays(filteredSkips.map(s => s.date));
    }

    const { data: skipData, error } = await supabase
        .from('skip_days')
        .select('date')
        .eq('date', dateString)
        .or(`device_id.eq.${deviceId},device_id.is.null,device_id.eq.home_desktop_agent`)
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
      console.log(`[SCHEDULER] Today (${dateString}) is skipped (Weekend/Holiday). No automation scheduled for ${deviceId}.`);
      
      const payload = {
          date: dateString,
          device_id: deviceId,
          skipped: true,
          scheduled_clock_in: null,
          scheduled_clock_out: null,
          clock_in_done: false,
          clock_out_done: false
      };

      if (supabaseOnline) {
          try {
              await supabase.from('daily_schedules').upsert(payload);
              await supabase.from('logs').insert({ action: 'scheduler', status: 'skipped', message: `Automation skipped for ${dateString}`, device_id: deviceId });
              cacheManager.mergeDailySchedule(payload, true);
          } catch(e) {
              cacheManager.mergeDailySchedule(payload, false);
              cacheManager.logOffline('scheduler', 'skipped', `Automation skipped for ${dateString}`);
          }
      } else {
          cacheManager.mergeDailySchedule(payload, false);
          cacheManager.logOffline('scheduler', 'skipped', `Automation skipped for ${dateString}`);
      }
      scheduleCronJobs(payload, supabase);
      return;
  }
  
  // 2. Generate random times
  const inMinute = getRandomMinute(45, 50);
  const inTimeStr = `07:${inMinute.toString().padStart(2, '0')}`;
  
  const outMinute = getRandomMinute(5, 10);
  const outTimeStr = `17:${outMinute.toString().padStart(2, '0')}`;
  
  const scheduleData = {
      date: dateString,
      device_id: deviceId,
      skipped: false,
      scheduled_clock_in: inTimeStr,
      scheduled_clock_out: outTimeStr,
      clock_in_done: false,
      clock_out_done: false
  };
  
  console.log(`[SCHEDULER] Generated schedule for ${dateString} [Device: ${deviceId}]: IN=${inTimeStr}, OUT=${outTimeStr}`);
  
  if (supabaseOnline) {
      try {
        await supabase.from('daily_schedules').upsert(scheduleData);
        console.log('[SCHEDULER] Synced today\'s schedule to Supabase daily_schedules.');
        cacheManager.mergeDailySchedule(scheduleData, true);
      } catch (err) {
        console.error('[SCHEDULER] Failed to sync schedule to Supabase:', err.message);
        cacheManager.mergeDailySchedule(scheduleData, false);
      }
  } else {
      console.log('[SCHEDULER] Wrote schedule strictly to local cache (synced=false).');
      cacheManager.mergeDailySchedule(scheduleData, false);
  }
  
  if (global.updateTrayTooltip) global.updateTrayTooltip();
  
  scheduleCronJobs(scheduleData, supabase);
}

// Global references to running cron tasks
let clockInTask = null;
let clockOutTask = null;

function scheduleCronJobs(scheduleData, supabase) {
  if (clockInTask) clockInTask.stop();
  if (clockOutTask) clockOutTask.stop();

  if (scheduleData.skipped) return;
  
  const [inH, inM] = scheduleData.scheduled_clock_in.split(':');
  const [outH, outM] = scheduleData.scheduled_clock_out.split(':');
  
  // Time shift logic: Shift cron trigger 2 minutes early for pre-flight check + captive portal padding
  const inTime = new Date();
  inTime.setHours(Number(inH), Number(inM), 0, 0);
  inTime.setMinutes(inTime.getMinutes() - 2);
  const cronInH = inTime.getHours();
  const cronInM = inTime.getMinutes();
  
  const outTime = new Date();
  outTime.setHours(Number(outH), Number(outM), 0, 0);
  outTime.setMinutes(outTime.getMinutes() - 2);
  const cronOutH = outTime.getHours();
  const cronOutM = outTime.getMinutes();
  
  if (!scheduleData.clock_in_done) {
    clockInTask = cron.schedule(`${cronInM} ${cronInH} * * *`, async () => {
      const todayStr = new Date().toLocaleDateString('en-CA');
      if (scheduleData.date !== todayStr) {
        console.warn(`[SCHEDULER] Aborting Clock IN cron callback: date mismatch (expected ${scheduleData.date}, got ${todayStr}).`);
        return;
      }
      console.log('[SCHEDULER] Triggering scheduled Clock IN...');
      try {
        const targetDate = buildLocalTargetDate(scheduleData.date, scheduleData.scheduled_clock_in);
        await executeClockAction('clock_in', supabase, {
          source: 'scheduler',
          targetAt: targetDate.toISOString()
        });
        try {
          const dateStr = scheduleData.date;
          await supabase.from('daily_schedules').update({ clock_in_done: true }).eq('date', dateStr);
          cacheManager.mergeDailySchedule({ clock_in_done: true }, true);
        } catch (e) {
          cacheManager.mergeDailySchedule({ clock_in_done: true }, false);
        }
      } catch (err) {
        console.error('[SCHEDULER] Scheduled Clock IN failed:', err.message);
      }
    });
  }
  
  if (!scheduleData.clock_out_done) {
    clockOutTask = cron.schedule(`${cronOutM} ${cronOutH} * * *`, async () => {
      const todayStr = new Date().toLocaleDateString('en-CA');
      if (scheduleData.date !== todayStr) {
        console.warn(`[SCHEDULER] Aborting Clock OUT cron callback: date mismatch (expected ${scheduleData.date}, got ${todayStr}).`);
        return;
      }
      console.log('[SCHEDULER] Triggering scheduled Clock OUT...');
      try {
        const targetDate = buildLocalTargetDate(scheduleData.date, scheduleData.scheduled_clock_out);
        await executeClockAction('clock_out', supabase, {
          source: 'scheduler',
          targetAt: targetDate.toISOString()
        });
        try {
          const dateStr = scheduleData.date;
          await supabase.from('daily_schedules').update({ clock_out_done: true }).eq('date', dateStr);
          cacheManager.mergeDailySchedule({ clock_out_done: true }, true);
        } catch (e) {
          cacheManager.mergeDailySchedule({ clock_out_done: true }, false);
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
  const dateString = today.toLocaleDateString('en-CA');
  
  if (scheduleData.date !== dateString) return;
  
  const now = Date.now();

  // Read proof from local cache to guard against duplicate automation.
  // If the user manually clocked in/out (or automation already ran and recorded proof),
  // we must NOT re-trigger — pressing clock-in twice on perakam registers the second
  // press as a clock-out instead.
  const proof = cacheManager.readCache().todays_proof;
  const proofIsForToday = proof && proof.date === dateString;
  const proofHasClockIn  = proofIsForToday && proof.clock_in  && proof.clock_in  !== '?';
  const proofHasClockOut = proofIsForToday && proof.clock_out && proof.clock_out !== '?';
  
  const [inH, inM] = scheduleData.scheduled_clock_in.split(':').map(Number);
  const targetInTime = new Date(today);
  targetInTime.setHours(inH, inM, 0, 0);
  
  const [outH, outM] = scheduleData.scheduled_clock_out.split(':').map(Number);
  const targetOutTime = new Date(today);
  targetOutTime.setHours(outH, outM, 0, 0);
  
  const gracePeriodMs = 300000; // 5 minutes
  
  if (!scheduleData.clock_in_done && !proofHasClockIn && now >= targetInTime.getTime() && (now - targetInTime.getTime()) <= gracePeriodMs) {
    console.log('[SCHEDULER] RECOVERY: Missed Clock IN! Triggering now...');
    try {
      await executeClockAction('clock_in', supabase, {
        source: 'recovery',
        targetAt: targetInTime.toISOString()
      });
      try {
        await supabase.from('daily_schedules').update({ clock_in_done: true }).eq('date', dateString);
        cacheManager.mergeDailySchedule({ clock_in_done: true }, true);
      } catch (e) {
        cacheManager.mergeDailySchedule({ clock_in_done: true }, false);
      }
    } catch (err) {}
  } else if (proofHasClockIn && !scheduleData.clock_in_done) {
    // Proof exists but flag not set — sync the flag to avoid future false recoveries
    console.log('[SCHEDULER] RECOVERY: Clock IN already recorded in proof, skipping automation. Syncing flag...');
    try {
      await supabase.from('daily_schedules').update({ clock_in_done: true }).eq('date', dateString);
      cacheManager.mergeDailySchedule({ clock_in_done: true }, true);
    } catch (e) {
      cacheManager.mergeDailySchedule({ clock_in_done: true }, false);
    }
  }
  
  if (!scheduleData.clock_out_done && !proofHasClockOut && now >= targetOutTime.getTime() && (now - targetOutTime.getTime()) <= gracePeriodMs) {
    console.log('[SCHEDULER] RECOVERY: Missed Clock OUT! Triggering now...');
    try {
      await executeClockAction('clock_out', supabase, {
        source: 'recovery',
        targetAt: targetOutTime.toISOString()
      });
      try {
        await supabase.from('daily_schedules').update({ clock_out_done: true }).eq('date', dateString);
        cacheManager.mergeDailySchedule({ clock_out_done: true }, true);
      } catch (e) {
        cacheManager.mergeDailySchedule({ clock_out_done: true }, false);
      }
    } catch (err) {}
  } else if (proofHasClockOut && !scheduleData.clock_out_done) {
    // Proof exists but flag not set — sync the flag to avoid future false recoveries
    console.log('[SCHEDULER] RECOVERY: Clock OUT already recorded in proof, skipping automation. Syncing flag...');
    try {
      await supabase.from('daily_schedules').update({ clock_out_done: true }).eq('date', dateString);
      cacheManager.mergeDailySchedule({ clock_out_done: true }, true);
    } catch (e) {
      cacheManager.mergeDailySchedule({ clock_out_done: true }, false);
    }
  }
}

async function init(supabase) {
  const today = new Date();
  const dateString = today.toLocaleDateString('en-CA');
  
  let scheduleData = null;
  try {
    const { data: allSkips } = await supabase.from('skip_days').select('date');
    if (allSkips && Array.isArray(allSkips)) {
      cacheManager.updateSkipDays(allSkips.map(s => s.date));
    }

    const { data: skipData } = await supabase
      .from('skip_days')
      .select('date')
      .eq('date', dateString)
      .maybeSingle();
    const isSkipDay = !!skipData;

    const { data, error } = await supabase
      .from('daily_schedules')
      .select('*')
      .eq('date', dateString)
      .maybeSingle();
      
    if (error) throw error;
    scheduleData = data;

    if (scheduleData && isSkipDay && !scheduleData.skipped) {
      console.log(`[SCHEDULER] Day was marked as skipped AFTER schedule generation. Updating...`);
      scheduleData.skipped = true;
      scheduleData.scheduled_clock_in = null;
      scheduleData.scheduled_clock_out = null;
      await supabase.from('daily_schedules').upsert(scheduleData);
      cacheManager.mergeDailySchedule(scheduleData, true);
    } else if (scheduleData && !isSkipDay && scheduleData.skipped) {
       const dayOfWeek = today.getDay();
       if (dayOfWeek !== 0 && dayOfWeek !== 6) {
         console.log(`[SCHEDULER] Day was un-skipped! Removing old skipped schedule to force regeneration...`);
         scheduleData = null;
         await supabase.from('daily_schedules').delete().eq('date', dateString);
       }
    }

    if (scheduleData) {
        cacheManager.mergeDailySchedule({
            date: scheduleData.date,
            skipped: scheduleData.skipped,
            scheduled_clock_in: scheduleData.scheduled_clock_in,
            scheduled_clock_out: scheduleData.scheduled_clock_out,
            clock_in_done: scheduleData.clock_in_done,
            clock_out_done: scheduleData.clock_out_done
        }, true);
    }
  } catch (err) {
    console.error(`[SCHEDULER] Supabase offline on boot! Reading from local cache.`);
    const cache = cacheManager.readCache();
    scheduleData = cache.daily_schedule;
  }
  
  if (scheduleData && scheduleData.date === dateString) {
    console.log(`[SCHEDULER] Loaded existing schedule for today (${dateString}).`);
    scheduleCronJobs(scheduleData, supabase);
    await checkMissedActions(scheduleData, supabase);
  } else {
    console.log(`[SCHEDULER] No current schedule found for ${dateString}, generating new one...`);
    await generateDailySchedule(supabase);
    // After generating a fresh schedule (e.g. app resumed after sleep past the cron window),
    // immediately check for missed actions — cron jobs for past times will never fire on their own.
    const cache = cacheManager.readCache();
    if (cache.daily_schedule && cache.daily_schedule.date === dateString) {
      await checkMissedActions(cache.daily_schedule, supabase);
    }
  }
  
  if (global.midnightTask) {
    global.midnightTask.stop();
  }

  // Midnight cron: generate tomorrow's schedule at the day boundary.
  // Wrapped in async try/catch with a 5-minute retry so a transient error
  // (e.g. Supabase briefly unreachable at midnight) doesn't silently drop the day.
  global.midnightTask = cron.schedule('0 0 * * *', async () => {
    try {
      await generateDailySchedule(supabase);
    } catch (err) {
      console.error('[SCHEDULER] Midnight schedule generation failed, will retry in 5 minutes:', err.message);
      setTimeout(async () => {
        try {
          await generateDailySchedule(supabase);
          console.log('[SCHEDULER] Midnight schedule retry succeeded.');
        } catch (retryErr) {
          console.error('[SCHEDULER] Midnight schedule retry also failed:', retryErr.message);
        }
      }, 5 * 60 * 1000);
    }
  });
}

module.exports = {
  init,
  __test: {
    buildLocalTargetDate,
    scheduleCronJobs,
    checkMissedActions
  }
};
