const cron = require('node-cron');
const cacheManager = require('./cache-manager');

const VERSION = '1.7.2';
const HOME_DEVICE_ID = 'home_desktop_agent';
const GRACE_PERIOD_MS = 300000; // 5 minutes
const SLEEP_JUMP_THRESHOLD_MS = 45000;
const HEALTH_CHECK_INTERVAL_MS = 60000;
const MAX_BACKOFF_RETRIES = 5;
const VALID_DAY_MODES = ['normal', 'full_skip', 'clock_in_only', 'clock_out_only'];

const runtimeDependencies = {
  executeClockAction: (...args) => require('./automation').executeClockAction(...args),
  cronSchedule: (expr, cb, opts) => cron.schedule(expr, cb, opts)
};

function setRuntimeDependenciesForTest(overrides = {}) {
  if (overrides.executeClockAction) runtimeDependencies.executeClockAction = overrides.executeClockAction;
  if (overrides.cronSchedule) runtimeDependencies.cronSchedule = overrides.cronSchedule;
}

function resetRuntimeDependencies() {
  runtimeDependencies.executeClockAction = (...args) => require('./automation').executeClockAction(...args);
  runtimeDependencies.cronSchedule = (expr, cb, opts) => cron.schedule(expr, cb, opts);
}

// Process-wide singleton state prevents split-brain cron tasks across dynamic reloads
function getSchedulerState() {
  if (!global.__alsSchedulerState) {
    global.__alsSchedulerState = {
      clockInTask: null,
      clockOutTask: null,
      diagnosticTask: null,
      midnightTask: null,
      sleepDetectorTimer: null,
      healthTimer: null,
      retryTimer: null,
      lastWallClockMs: Date.now(),
      clockInJobId: 0,
      clockOutJobId: 0,
      diagnosticJobId: 0,
      clockInBoundRevision: 0,
      clockOutBoundRevision: 0,
      clockInTargetTime: null,
      clockOutTargetTime: null,
      clockInDate: null,
      clockOutDate: null,
      currentAppliedRevision: 0,
      knownLatestRevision: 0,
      policyUncertain: false,
      inFlightClaims: new Set(),
      inFlightExecution: null,
      reconcileChain: Promise.resolve(),
      activeSupabase: null,
      initialized: false,
      initAttempts: 0,
      consecutiveFailures: 0,
      lastReconcileAt: null,
      lastSuccessReconcileAt: null,
      lastReconcileTrigger: null,
      lastError: null,
      lastErrorCategory: null,
      lastEvaluatedDate: null,
      lastHealthCheckAt: null,
      healthStatus: 'initializing',
      healthIssues: [],
      nextRetryAt: null,
      scheduleWriteSynced: false,
      lastEvaluation: null,
      lastSchedulePayload: null
    };
  }
  return global.__alsSchedulerState;
}

function getRandomMinute(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function buildLocalTargetDate(dateString, timeString) {
  const [year, month, day] = dateString.split('-').map(Number);
  const [hour, minute] = timeString.split(':').map(Number);
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

function getLocalDateString(dateObj = new Date()) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getLocalDayOfWeek(dateString) {
  const [y, m, d] = dateString.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0).getDay();
}

function generateRandomTimeStr(baseTimeStr, durationMinutes = 5) {
  if (!baseTimeStr || typeof baseTimeStr !== 'string') baseTimeStr = '07:45';
  const [hStr, mStr] = baseTimeStr.split(':');
  const parsedHour = parseInt(hStr, 10);
  const parsedMin = parseInt(mStr, 10);
  const baseHour = Number.isFinite(parsedHour) ? parsedHour : 7;
  const baseMin = Number.isFinite(parsedMin) ? parsedMin : 45;
  const dur = Math.max(0, parseInt(durationMinutes, 10) || 0);

  const baseTotalMins = baseHour * 60 + baseMin;
  const offset = dur > 0 ? getRandomMinute(0, dur) : 0;
  const targetTotalMins = baseTotalMins + offset;

  const targetHour = Math.floor(targetTotalMins / 60) % 24;
  const targetMin = targetTotalMins % 60;

  return `${targetHour.toString().padStart(2, '0')}:${targetMin.toString().padStart(2, '0')}`;
}

function isValidDayMode(mode) {
  return VALID_DAY_MODES.includes(mode);
}

function modeCapabilities(mode) {
  switch (mode) {
    case 'normal':
      return { clockIn: true, clockOut: true };
    case 'clock_in_only':
      return { clockIn: true, clockOut: false };
    case 'clock_out_only':
      return { clockIn: false, clockOut: true };
    case 'full_skip':
    default:
      return { clockIn: false, clockOut: false };
  }
}

function isValidProofTime(val) {
  if (!val || typeof val !== 'string') return false;
  const trimmed = val.trim();
  return trimmed !== '' && trimmed !== '?' && trimmed !== '--:--' && trimmed.length > 2;
}

function matchesRecurringRule(dateString, rule) {
  if (!rule || rule.enabled === false) return false;
  if (!isValidDayMode(rule.mode)) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) return false;

  if (rule.effective_from && dateString < rule.effective_from) return false;
  if (rule.effective_to && dateString > rule.effective_to) return false;

  const [year, month, day] = dateString.split('-').map(Number);
  const dateObj = new Date(year, month - 1, day, 12, 0, 0, 0);
  const dow = dateObj.getDay();

  if (rule.recurrence_type === 'weekly') {
    return Number(rule.day_of_week) === dow;
  }

  if (rule.recurrence_type === 'monthly_day') {
    return Number(rule.day_of_month) === day;
  }

  if (rule.recurrence_type === 'monthly_nth_weekday') {
    if (Number(rule.day_of_week) !== dow) return false;
    const nth = Number(rule.nth_week);
    if (nth === -1) {
      const daysInMonth = new Date(year, month, 0).getDate();
      return day + 7 > daysInMonth;
    }
    if (nth >= 1 && nth <= 4) {
      return Math.ceil(day / 7) === nth;
    }
    return false;
  }

  return false;
}

function getRuleSpecificityScore(rule) {
  if (!rule) return 0;
  if (rule.recurrence_type === 'monthly_day') return 3;
  if (rule.recurrence_type === 'monthly_nth_weekday') return 2;
  if (rule.recurrence_type === 'weekly') return 1;
  return 0;
}

/**
 * Deterministically evaluates a calendar date against:
 * 1. Specific-date manual override
 * 2. Approved public holiday (or legacy skip_days entry)
 * 3. Active recurring rule (highest priority, then specificity)
 * 4. Configured weekly working-day default
 * 5. System default (Mon-Fri normal, Sat-Sun full_skip)
 */
function evaluateDatePolicy(dateString, policyState = {}) {
  const dow = getLocalDayOfWeek(dateString);
  const systemDefaultMode = (dow === 0 || dow === 6) ? 'full_skip' : 'normal';
  const overrides = policyState.date_overrides || {};
  const holidays = policyState.holidays || {};
  const rules = Array.isArray(policyState.recurring_rules) ? policyState.recurring_rules : [];
  const weeklyDefaults = policyState.weekly_defaults || {};

  const override = overrides[dateString];
  const holiday = holidays[dateString];
  const isLegacySkipInArray = Array.isArray(policyState.skip_days) && policyState.skip_days.includes(dateString);

  // 1. Specific-date manual override (excluding migrated legacy rows if a holiday exists)
  if (override && isValidDayMode(override.mode) && override.source !== 'legacy_skip_day') {
    const caps = modeCapabilities(override.mode);
    return {
      date: dateString,
      dayOfWeek: dow,
      effectiveMode: override.mode,
      clockInEnabled: caps.clockIn,
      clockOutEnabled: caps.clockOut,
      ruleSource: override.source || 'manual_override',
      ruleLabel: override.reason || `Manual override (${override.mode})`,
      ruleId: null,
      isManualOverride: true,
      isApprovedHoliday: false,
      isSuggestedHoliday: Boolean(holiday && !holiday.approved),
      holidayName: holiday ? holiday.name : null,
      isRecurringMatch: false,
      isWeekendDefault: false,
      matchedRulesCount: 0
    };
  }

  // 2. Approved public holiday or legacy skip_days entry
  if (holiday && holiday.approved === true && isValidDayMode(holiday.mode)) {
    const caps = modeCapabilities(holiday.mode);
    return {
      date: dateString,
      dayOfWeek: dow,
      effectiveMode: holiday.mode,
      clockInEnabled: caps.clockIn,
      clockOutEnabled: caps.clockOut,
      ruleSource: 'approved_holiday',
      ruleLabel: `Holiday: ${holiday.name || 'Approved Public Holiday'}`,
      ruleId: null,
      isManualOverride: false,
      isApprovedHoliday: true,
      isSuggestedHoliday: false,
      holidayName: holiday.name || null,
      isRecurringMatch: false,
      isWeekendDefault: false,
      matchedRulesCount: 0
    };
  }

  if ((override && override.source === 'legacy_skip_day' && isValidDayMode(override.mode)) || isLegacySkipInArray) {
    const mode = (override && override.mode) || 'full_skip';
    const caps = modeCapabilities(mode);
    return {
      date: dateString,
      dayOfWeek: dow,
      effectiveMode: mode,
      clockInEnabled: caps.clockIn,
      clockOutEnabled: caps.clockOut,
      ruleSource: 'legacy_skip_day',
      ruleLabel: (override && override.reason) || 'Legacy Skip Day',
      ruleId: null,
      isManualOverride: true,
      isApprovedHoliday: false,
      isSuggestedHoliday: Boolean(holiday && !holiday.approved),
      holidayName: holiday ? holiday.name : null,
      isRecurringMatch: false,
      isWeekendDefault: false,
      matchedRulesCount: 0
    };
  }

  // 3. Active recurring rules sorted deterministically
  const matchingRules = rules
    .filter(r => matchesRecurringRule(dateString, r))
    .sort((a, b) => {
      const prioDiff = (Number(b.priority) || 0) - (Number(a.priority) || 0);
      if (prioDiff !== 0) return prioDiff;
      const specDiff = getRuleSpecificityScore(b) - getRuleSpecificityScore(a);
      if (specDiff !== 0) return specDiff;
      const timeA = a.updated_at ? new Date(a.updated_at).getTime() : 0;
      const timeB = b.updated_at ? new Date(b.updated_at).getTime() : 0;
      if (timeB !== timeA) return timeB - timeA;
      return String(a.id || a.name || '').localeCompare(String(b.id || b.name || ''));
    });

  if (matchingRules.length > 0) {
    const topRule = matchingRules[0];
    const caps = modeCapabilities(topRule.mode);
    return {
      date: dateString,
      dayOfWeek: dow,
      effectiveMode: topRule.mode,
      clockInEnabled: caps.clockIn,
      clockOutEnabled: caps.clockOut,
      ruleSource: 'recurring_rule',
      ruleLabel: `Recurring: ${topRule.name || topRule.recurrence_type}`,
      ruleId: topRule.id || null,
      isManualOverride: false,
      isApprovedHoliday: false,
      isSuggestedHoliday: Boolean(holiday && !holiday.approved),
      holidayName: holiday ? holiday.name : null,
      isRecurringMatch: true,
      isWeekendDefault: false,
      matchedRulesCount: matchingRules.length
    };
  }

  // 4. Configured weekly working-day defaults
  const configuredWeeklyMode = weeklyDefaults[String(dow)] !== undefined
    ? weeklyDefaults[String(dow)]
    : weeklyDefaults[dow];
  if (isValidDayMode(configuredWeeklyMode)) {
    const caps = modeCapabilities(configuredWeeklyMode);
    return {
      date: dateString,
      dayOfWeek: dow,
      effectiveMode: configuredWeeklyMode,
      clockInEnabled: caps.clockIn,
      clockOutEnabled: caps.clockOut,
      ruleSource: 'weekly_default',
      ruleLabel: configuredWeeklyMode === 'full_skip' && (dow === 0 || dow === 6)
        ? 'Weekly default (Weekend Skip)'
        : `Weekly default (${configuredWeeklyMode})`,
      ruleId: null,
      isManualOverride: false,
      isApprovedHoliday: false,
      isSuggestedHoliday: Boolean(holiday && !holiday.approved),
      holidayName: holiday ? holiday.name : null,
      isRecurringMatch: false,
      isWeekendDefault: (dow === 0 || dow === 6) && configuredWeeklyMode === 'full_skip',
      matchedRulesCount: 0
    };
  }

  // 5. Existing system defaults
  const caps = modeCapabilities(systemDefaultMode);
  return {
    date: dateString,
    dayOfWeek: dow,
    effectiveMode: systemDefaultMode,
    clockInEnabled: caps.clockIn,
    clockOutEnabled: caps.clockOut,
    ruleSource: 'system_default',
    ruleLabel: (dow === 0 || dow === 6) ? 'System default (Weekend Skip)' : 'System default (Workday)',
    ruleId: null,
    isManualOverride: false,
    isApprovedHoliday: false,
    isSuggestedHoliday: Boolean(holiday && !holiday.approved),
    holidayName: holiday ? holiday.name : null,
    isRecurringMatch: false,
    isWeekendDefault: dow === 0 || dow === 6,
    matchedRulesCount: 0
  };
}

function evaluateCalendarRange(startDateStr, endDateStr, policyState = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDateStr) || !/^\d{4}-\d{2}-\d{2}$/.test(endDateStr)) {
    return [];
  }
  const [sy, sm, sd] = startDateStr.split('-').map(Number);
  const [ey, em, ed] = endDateStr.split('-').map(Number);
  const cursor = new Date(sy, sm - 1, sd, 12, 0, 0, 0);
  const end = new Date(ey, em - 1, ed, 12, 0, 0, 0);

  const results = [];
  let guard = 0;
  while (cursor <= end && guard < 366) {
    results.push(evaluateDatePolicy(getLocalDateString(cursor), policyState));
    cursor.setDate(cursor.getDate() + 1);
    guard++;
  }
  return results;
}

function expandBulkDates(selectionSpec = {}) {
  const mode = selectionSpec.mode || 'single';
  if (mode === 'single') {
    return selectionSpec.date ? [selectionSpec.date] : [];
  }
  if (mode === 'multiple') {
    const raw = Array.isArray(selectionSpec.dates) ? selectionSpec.dates : [];
    return Array.from(new Set(raw.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)))).sort();
  }
  const startStr = selectionSpec.startDate;
  const endStr = selectionSpec.endDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startStr || '') || !/^\d{4}-\d{2}-\d{2}$/.test(endStr || '')) {
    return [];
  }
  const [sy, sm, sd] = startStr.split('-').map(Number);
  const [ey, em, ed] = endStr.split('-').map(Number);
  const cursor = new Date(sy, sm - 1, sd, 12, 0, 0, 0);
  const end = new Date(ey, em - 1, ed, 12, 0, 0, 0);

  const dates = [];
  let guard = 0;
  while (cursor <= end && guard < 366) {
    const dStr = getLocalDateString(cursor);
    const dow = cursor.getDay();
    const isWeekend = dow === 0 || dow === 6;
    if (mode === 'range_all' || (mode === 'range_weekdays' && !isWeekend) || (mode === 'range_weekends' && isWeekend)) {
      dates.push(dStr);
    }
    cursor.setDate(cursor.getDate() + 1);
    guard++;
  }
  return dates;
}

function resolveRuntimeIdentity() {
  const deviceConfig = typeof cacheManager.getDeviceConfig === 'function'
    ? cacheManager.getDeviceConfig()
    : {};
  let deviceId = deviceConfig.device_id || HOME_DEVICE_ID;
  try {
    const supabaseClient = require('./supabase-client');
    if (typeof supabaseClient.getDeviceId === 'function') {
      deviceId = supabaseClient.getDeviceId();
    }
  } catch (_) {}

  const edition = (
    process.env.ALS_EDITION ||
    deviceConfig.edition ||
    (typeof cacheManager.getAppEdition === 'function' ? cacheManager.getAppEdition() : 'full')
  ).toLowerCase();

  return { deviceId, edition, deviceConfig };
}

function isAuthorizedAutoScheduleIdentity({ deviceId, edition, deviceConfig }) {
  if (edition !== 'full') {
    return { allowed: false, reason: `Edition "${edition}" is excluded from auto scheduling` };
  }
  if (deviceId !== HOME_DEVICE_ID) {
    return { allowed: false, reason: `Device "${deviceId}" is not authorized for automatic clock scheduling` };
  }
  if (deviceConfig && deviceConfig.auto_clock_enabled === false) {
    return { allowed: false, reason: 'Auto Clock Disabled' };
  }
  return { allowed: true, reason: null };
}

function isMissingSchemaError(err) {
  if (!err) return false;
  const code = String(err.code || '').toUpperCase();
  const msg = String(err.message || '').toLowerCase();
  return code === '42P01' || code === 'PGRST205' || code === '42703' || msg.includes('does not exist') || msg.includes('could not find');
}

function stopCronJobs() {
  const state = getSchedulerState();
  state.clockInJobId++;
  state.clockOutJobId++;
  state.diagnosticJobId++;

  if (state.inFlightExecution) {
    state.inFlightExecution.aborted = true;
  }

  if (state.diagnosticTask) {
    try { state.diagnosticTask.stop(); } catch (_) {}
    state.diagnosticTask = null;
  }
  if (state.clockInTask) {
    try { state.clockInTask.stop(); } catch (_) {}
    state.clockInTask = null;
  }
  if (state.clockOutTask) {
    try { state.clockOutTask.stop(); } catch (_) {}
    state.clockOutTask = null;
  }
  state.clockInTargetTime = null;
  state.clockOutTargetTime = null;
}

function cancelActionCronJob(actionType) {
  const state = getSchedulerState();
  if (state.inFlightExecution && state.inFlightExecution.actionType === actionType) {
    state.inFlightExecution.aborted = true;
  }
  if (actionType === 'clock_in') {
    state.clockInJobId++;
    if (state.clockInTask) {
      try { state.clockInTask.stop(); } catch (_) {}
      state.clockInTask = null;
    }
    if (state.diagnosticTask) {
      try { state.diagnosticTask.stop(); } catch (_) {}
      state.diagnosticTask = null;
    }
    state.clockInTargetTime = null;
  } else if (actionType === 'clock_out') {
    state.clockOutJobId++;
    if (state.clockOutTask) {
      try { state.clockOutTask.stop(); } catch (_) {}
      state.clockOutTask = null;
    }
    state.clockOutTargetTime = null;
  }
}

async function fetchAuthoritativePolicy(supabase, deviceId) {
  const localPolicy = cacheManager.getSchedulePolicy
    ? cacheManager.getSchedulePolicy()
    : { revision: 1, weekly_defaults: {}, date_overrides: {}, recurring_rules: [], holidays: {} };

  if (!supabase || typeof supabase.from !== 'function') {
    return { policy: localPolicy, supabaseOnline: false, schemaReady: localPolicy.schema_ready !== false };
  }

  let supabaseOnline = true;
  let schemaReady = true;
  const nextPolicy = {
    ...localPolicy,
    date_overrides: {},
    recurring_rules: [],
    holidays: {},
    skip_days: []
  };

  // 1. Legacy skip_days fetch (preserves backward compatibility & test mocks expecting .select('date'))
  try {
    const legacyRes = await supabase.from('skip_days').select('date');
    if (legacyRes && legacyRes.error) throw legacyRes.error;
    if (legacyRes && Array.isArray(legacyRes.data)) {
      const skipList = legacyRes.data
        .filter(row => !row.device_id || row.device_id === deviceId || row.device_id === HOME_DEVICE_ID)
        .map(row => row.date)
        .filter(Boolean);
      nextPolicy.skip_days = Array.from(new Set(skipList)).sort();
      if (typeof cacheManager.updateSkipDays === 'function') {
        cacheManager.updateSkipDays(skipList);
      }
    }
  } catch (legacyErr) {
    if (!isMissingSchemaError(legacyErr)) {
      supabaseOnline = false;
    }
  }

  // 2. Fetch schedule_policy_state
  try {
    const stateRes = await supabase
      .from('schedule_policy_state')
      .select('*')
      .eq('device_id', deviceId)
      .maybeSingle();

    if (stateRes && stateRes.error) {
      if (isMissingSchemaError(stateRes.error)) {
        schemaReady = false;
      } else {
        throw stateRes.error;
      }
    } else if (stateRes && stateRes.data && typeof stateRes.data === 'object') {
      if (stateRes.data.revision !== undefined) {
        nextPolicy.revision = Number(stateRes.data.revision) || nextPolicy.revision;
      }
      if (stateRes.data.weekly_defaults) {
        nextPolicy.weekly_defaults = stateRes.data.weekly_defaults;
      }
      if (stateRes.data.applied_revision !== undefined) {
        nextPolicy.applied_revision = Number(stateRes.data.applied_revision) || 0;
      }
      nextPolicy.last_change_source = stateRes.data.last_change_source || null;
      nextPolicy.last_change_summary = stateRes.data.last_change_summary || null;
    }
  } catch (err) {
    if (isMissingSchemaError(err)) {
      schemaReady = false;
    } else {
      supabaseOnline = false;
    }
  }

  // 3. Fetch schedule_date_overrides, schedule_recurring_rules, schedule_holidays if schema is ready
  if (schemaReady && supabaseOnline) {
    try {
      const [ovRes, recRes, holRes] = await Promise.all([
        supabase.from('schedule_date_overrides').select('*').eq('device_id', deviceId),
        supabase.from('schedule_recurring_rules').select('*').eq('device_id', deviceId),
        supabase.from('schedule_holidays').select('*').eq('device_id', deviceId)
      ]);

      const anyErr = (ovRes && ovRes.error) || (recRes && recRes.error) || (holRes && holRes.error);
      if (anyErr) {
        if (isMissingSchemaError(anyErr)) {
          schemaReady = false;
        } else {
          throw anyErr;
        }
      } else {
        if (ovRes && Array.isArray(ovRes.data)) {
          for (const row of ovRes.data) {
            if (row && row.date && isValidDayMode(row.mode)) {
              nextPolicy.date_overrides[row.date] = {
                date: row.date,
                mode: row.mode,
                reason: row.reason || null,
                source: row.source || 'manual_override',
                updated_at: row.updated_at || null
              };
            }
          }
        }
        if (recRes && Array.isArray(recRes.data)) {
          nextPolicy.recurring_rules = recRes.data.filter(r => r && isValidDayMode(r.mode));
        }
        if (holRes && Array.isArray(holRes.data)) {
          for (const h of holRes.data) {
            if (h && h.date) {
              nextPolicy.holidays[h.date] = {
                date: h.date,
                name: h.name || 'Holiday',
                state_scope: h.state_scope || 'National',
                mode: isValidDayMode(h.mode) ? h.mode : 'full_skip',
                source: h.source || 'manual',
                approved: h.approved === true,
                approved_at: h.approved_at || null
              };
            }
          }
        }
      }
    } catch (err) {
      if (isMissingSchemaError(err)) {
        schemaReady = false;
      } else {
        supabaseOnline = false;
      }
    }
  }

  // Merge legacy skip_days into date_overrides as legacy_skip_day only if no explicit override exists
  if (supabaseOnline) {
    for (const d of nextPolicy.skip_days) {
      if (!nextPolicy.date_overrides[d]) {
        nextPolicy.date_overrides[d] = {
          date: d,
          mode: 'full_skip',
          source: 'legacy_skip_day',
          reason: 'Legacy skip_days record'
        };
      }
    }
  } else {
    return { policy: localPolicy, supabaseOnline: false, schemaReady };
  }

  nextPolicy.schema_ready = schemaReady;
  return { policy: nextPolicy, supabaseOnline: true, schemaReady };
}

async function fetchTodaysExistingRecords(supabase, dateString, deviceId) {
  const cache = cacheManager.readCache();
  let cachedSched = (cache.daily_schedule && cache.daily_schedule.date === dateString) ? cache.daily_schedule : null;
  let cachedProof = (cache.todays_proof && cache.todays_proof.date === dateString) ? cache.todays_proof : null;

  if (!supabase || typeof supabase.from !== 'function') {
    return { existingSched: cachedSched, proof: cachedProof };
  }

  let cloudSched = null;
  let cloudProof = null;

  try {
    const schedRes = await supabase
      .from('daily_schedules')
      .select('*')
      .eq('date', dateString)
      .or(`device_id.eq.${deviceId},device_id.is.null`)
      .maybeSingle();

    if (schedRes && !schedRes.error && schedRes.data && schedRes.data.date === dateString) {
      cloudSched = schedRes.data;
    }
  } catch (_) {}

  try {
    const proofRes = await supabase
      .from('todays_proof')
      .select('*')
      .eq('date', dateString)
      .or(`device_id.eq.${deviceId},device_id.is.null`)
      .maybeSingle();

    if (proofRes && !proofRes.error && proofRes.data && proofRes.data.date === dateString) {
      cloudProof = proofRes.data;
    }
  } catch (_) {}

  const mergedSched = cloudSched || cachedSched ? {
    ...(cachedSched || {}),
    ...(cloudSched || {}),
    clock_in_done: Boolean((cloudSched && cloudSched.clock_in_done) || (cachedSched && cachedSched.clock_in_done)),
    clock_out_done: Boolean((cloudSched && cloudSched.clock_out_done) || (cachedSched && cachedSched.clock_out_done)),
    planned_clock_in: (cloudSched && (cloudSched.planned_clock_in || cloudSched.scheduled_clock_in)) || (cachedSched && (cachedSched.planned_clock_in || cachedSched.scheduled_clock_in)) || null,
    planned_clock_out: (cloudSched && (cloudSched.planned_clock_out || cloudSched.scheduled_clock_out)) || (cachedSched && (cachedSched.planned_clock_out || cachedSched.scheduled_clock_out)) || null
  } : null;

  const mergedProof = cloudProof || cachedProof;
  return { existingSched: mergedSched, proof: mergedProof };
}

async function runPortalHealthDiagnostics(supabase, options = {}) {
  const deviceConfig = cacheManager.getDeviceConfig ? cacheManager.getDeviceConfig() : {};
  const targetDeviceId = options.deviceId || deviceConfig.device_id || HOME_DEVICE_ID;
  const targetUrl = options.targetUrl || deviceConfig.target_url || 'https://perakamwaktu.upm.edu.my/';

  const results = {
    timestamp: new Date().toISOString(),
    network: 'ok',
    portal: 'ok',
    statusCode: null,
    issue: null
  };

  // 1. Network / Captive Portal check
  try {
    const fetchResp = await fetch('http://neverssl.com', { signal: AbortSignal.timeout(5000) });
    const text = await fetchResp.text();
    if (!text.includes('<html')) {
      results.network = 'captive_portal';
      results.issue = 'Wi-Fi Captive Portal detected (redirected). Network requires campus login.';
    }
  } catch (netErr) {
    console.warn('[HEALTH-CHECK] Pre-flight route ping warning:', netErr.message);
  }

  // 2. Target Portal Reachability check
  if (!results.issue) {
    try {
      const portalResp = await fetch(targetUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(10000),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'
        }
      });
      results.statusCode = portalResp.status;

      if (portalResp.status >= 500) {
        results.portal = 'server_error';
        results.issue = `UPM Portal returned server error HTTP ${portalResp.status}. Possible server maintenance.`;
      } else {
        const portalText = (await portalResp.text().catch(() => '')).toLowerCase();
        if (
          portalText.includes('penyelenggaraan') ||
          portalText.includes('maintenance') ||
          portalText.includes('under maintenance')
        ) {
          results.portal = 'maintenance';
          results.issue = 'UPM Portal is currently displaying a maintenance notice.';
        } else if (
          portalText.includes('fortiguard') ||
          portalText.includes('fortiweb') ||
          portalText.includes('web filter blocked')
        ) {
          results.portal = 'waf_blocked';
          results.issue = 'UPM Security Gateway (FortiWeb/FortiGuard) block detected.';
        }
      }
    } catch (portalErr) {
      results.portal = 'unreachable';
      results.issue = `Unable to connect to UPM Portal (${portalErr.message}). Check internet connectivity.`;
    }
  }

  // 3. Handle results
  if (results.issue) {
    console.warn(`[HEALTH-CHECK] Diagnostic issue detected: ${results.issue}`);
    try {
      if (supabase && typeof supabase.from === 'function') {
        await supabase.from('logs').insert({
          action: 'preflight_diagnostic',
          status: 'warning',
          message: results.issue,
          device_id: targetDeviceId
        });
      }
    } catch (_) {}

    try {
      const automationMod = require('./automation');
      const sendTelegramAlert = (automationMod.__test && automationMod.__test.sendTelegramAlert) || automationMod.sendTelegramAlert;
      if (typeof sendTelegramAlert === 'function') {
        const alertMsg = `⚠️ [ALS Desktop] Pre-Flight Health Diagnostic Warning!\n\nIssue detected prior to scheduled attendance:\n📌 ${results.issue}\n\nScheduled Clock-In: ${options.scheduledTime || 'Upcoming'}`;
        await sendTelegramAlert(alertMsg, targetDeviceId);
      }
    } catch (telegramErr) {
      console.warn('[HEALTH-CHECK] Error dispatching diagnostic Telegram alert:', telegramErr.message);
    }
  } else {
    console.log('[HEALTH-CHECK] Pre-flight portal diagnostics PASSED. Portal is online and responsive.');
    try {
      if (supabase && typeof supabase.from === 'function') {
        await supabase.from('logs').insert({
          action: 'preflight_diagnostic',
          status: 'success',
          message: `Pre-flight health diagnostics passed (HTTP ${results.statusCode || 200}).`,
          device_id: targetDeviceId
        });
      }
    } catch (_) {}
  }

  return results;
}

/**
 * Revalidates policy right before automatic action execution.
 * Rejects disabled actions, stale jobs, uncertain policy freshness, or already-done actions.
 */
async function verifyPreExecutionGate(actionType, boundRevision, boundJobId, targetDateStr, supabase) {
  const state = getSchedulerState();
  const identity = resolveRuntimeIdentity();
  const authCheck = isAuthorizedAutoScheduleIdentity(identity);
  if (!authCheck.allowed) {
    return { allowed: false, reason: `UNAUTHORIZED: ${authCheck.reason}` };
  }

  const todayStr = getLocalDateString();
  if (targetDateStr && targetDateStr !== todayStr) {
    return { allowed: false, reason: `DATE_MISMATCH: expected ${targetDateStr}, got ${todayStr}` };
  }

  const currentJobId = actionType === 'clock_in' ? state.clockInJobId : state.clockOutJobId;
  if (boundJobId !== undefined && boundJobId !== null && boundJobId !== currentJobId) {
    return { allowed: false, reason: `OBSOLETE_JOB: bound job #${boundJobId} replaced by #${currentJobId}` };
  }

  if (boundRevision !== undefined && boundRevision !== null && boundRevision < state.currentAppliedRevision) {
    return { allowed: false, reason: `STALE_REVISION: bound rev ${boundRevision} < applied rev ${state.currentAppliedRevision}` };
  }

  // If a newer revision is known but not yet reconciled, reconcile now or fail safely
  if (state.knownLatestRevision > state.currentAppliedRevision || state.policyUncertain) {
    try {
      await reconcileSchedule(supabase, { triggerSource: 'pre_execution_sync', force: true });
    } catch (_) {
      return { allowed: false, reason: 'POLICY_UNCERTAIN: failed to reconcile pending newer revision' };
    }
    if (state.knownLatestRevision > state.currentAppliedRevision || state.policyUncertain) {
      return { allowed: false, reason: 'POLICY_UNCERTAIN: newer scheduling revision not confirmed locally' };
    }
  }

  // Live Supabase check to ensure no unseen cancellation arrived right before execution
  let livePolicy = cacheManager.getSchedulePolicy ? cacheManager.getSchedulePolicy() : {};
  let latestProof = cacheManager.readCache().todays_proof;
  let latestSched = cacheManager.readCache().daily_schedule;

  if (supabase && typeof supabase.from === 'function') {
    try {
      const stateRes = await Promise.race([
        supabase.from('schedule_policy_state').select('revision').eq('device_id', HOME_DEVICE_ID).maybeSingle(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 5000))
      ]);
      if (stateRes && stateRes.data && stateRes.data.revision !== undefined) {
        const remoteRev = Number(stateRes.data.revision) || 0;
        if (remoteRev > state.currentAppliedRevision) {
          state.knownLatestRevision = Math.max(state.knownLatestRevision, remoteRev);
          await reconcileSchedule(supabase, { triggerSource: 'pre_execution_remote_bump', force: true, eventRevision: remoteRev });
        }
      }
    } catch (netErr) {
      // Offline at exact execution minute: only proceed if local confirmed policy is clean and not uncertain
      if (!isMissingSchemaError(netErr) && state.currentAppliedRevision === 0) {
        return { allowed: false, reason: 'POLICY_UNCERTAIN: no confirmed local policy available offline' };
      }
    }

    // Re-read after potential reconcile
    livePolicy = cacheManager.getSchedulePolicy ? cacheManager.getSchedulePolicy() : {};
    const freshRecords = await fetchTodaysExistingRecords(supabase, todayStr, HOME_DEVICE_ID);
    if (freshRecords.proof) latestProof = freshRecords.proof;
    if (freshRecords.existingSched) latestSched = freshRecords.existingSched;
  }

  const evalResult = evaluateDatePolicy(todayStr, livePolicy);
  const actionEnabled = actionType === 'clock_in' ? evalResult.clockInEnabled : evalResult.clockOutEnabled;
  if (!actionEnabled) {
    return { allowed: false, reason: `CANCELLED_BY_POLICY: ${actionType} disabled under ${evalResult.effectiveMode} (${evalResult.ruleSource})` };
  }

  if (latestSched && latestSched.date === todayStr) {
    if (actionType === 'clock_in' && latestSched.clock_in_done) {
      return { allowed: false, reason: 'ALREADY_COMPLETED: clock_in_done is already true' };
    }
    if (actionType === 'clock_out' && latestSched.clock_out_done) {
      return { allowed: false, reason: 'ALREADY_COMPLETED: clock_out_done is already true' };
    }
  }

  if (latestProof && latestProof.date === todayStr) {
    if (actionType === 'clock_in' && isValidProofTime(latestProof.clock_in)) {
      return { allowed: false, reason: `ALREADY_COMPLETED: proof clock_in (${latestProof.clock_in}) exists` };
    }
    if (actionType === 'clock_out' && isValidProofTime(latestProof.clock_out)) {
      return { allowed: false, reason: `ALREADY_COMPLETED: proof clock_out (${latestProof.clock_out}) exists` };
    }
  }

  const claimKey = `${todayStr}:${actionType}`;
  if (state.inFlightClaims.has(claimKey)) {
    return { allowed: false, reason: `DUPLICATE_CLAIM: ${claimKey} is already executing` };
  }

  return { allowed: true, reason: null, claimKey, evalResult };
}

async function executeGatedScheduledAction(actionType, meta, supabase) {
  const state = getSchedulerState();
  const todayStr = getLocalDateString();

  const gate = await verifyPreExecutionGate(actionType, meta.boundRevision, meta.boundJobId, meta.dateString || todayStr, supabase);
  if (!gate.allowed) {
    console.warn(`[SCHEDULER] Pre-execution gate rejected ${actionType}: ${gate.reason}`);
    return { executed: false, skipped: true, reason: gate.reason };
  }

  state.inFlightClaims.add(gate.claimKey);
  state.inFlightExecution = {
    actionType,
    date: meta.dateString || todayStr,
    jobId: meta.boundJobId,
    boundRevision: meta.boundRevision,
    stage: 'preparing',
    aborted: false
  };

  try {
    const targetDate = buildLocalTargetDate(meta.dateString || todayStr, meta.plannedTime);
    const shouldAbort = () => {
      const exec = state.inFlightExecution;
      if (exec && exec.aborted) return true;
      const curJobId = actionType === 'clock_in' ? state.clockInJobId : state.clockOutJobId;
      if (meta.boundJobId !== undefined && curJobId !== meta.boundJobId) return true;
      const curPolicy = cacheManager.getSchedulePolicy ? cacheManager.getSchedulePolicy() : {};
      const curEval = evaluateDatePolicy(todayStr, curPolicy);
      const stillEnabled = actionType === 'clock_in' ? curEval.clockInEnabled : curEval.clockOutEnabled;
      return !stillEnabled;
    };

    const execRes = await runtimeDependencies.executeClockAction(actionType, supabase, {
      source: meta.source || 'scheduler',
      targetAt: targetDate.toISOString(),
      shouldAbort,
      onActiveClickStart: () => {
        if (state.inFlightExecution && state.inFlightExecution.jobId === meta.boundJobId) {
          state.inFlightExecution.stage = 'active_clicking';
        }
      }
    });

    if (execRes && (execRes.cancelled || String(execRes.reason || '').includes('ACTION_CANCELLED_BY_POLICY'))) {
      throw new Error('ACTION_CANCELLED_BY_POLICY');
    }
    if (execRes && execRes.success === false) {
      throw new Error(execRes.error || execRes.reason || `${actionType} returned failure`);
    }

    const doneField = actionType === 'clock_in' ? { clock_in_done: true, clock_in_status: 'completed' } : { clock_out_done: true, clock_out_status: 'completed' };
    try {
      if (supabase && typeof supabase.from === 'function') {
        await supabase.from('daily_schedules').update({ ...doneField, updated_at: new Date().toISOString() }).eq('date', todayStr).or(`device_id.eq.${HOME_DEVICE_ID},device_id.is.null`);
      }
      cacheManager.mergeDailySchedule({ date: todayStr, ...doneField }, true);
    } catch (_) {
      cacheManager.mergeDailySchedule({ date: todayStr, ...doneField }, false);
    }

    return { executed: true, skipped: false, reason: null };
  } catch (err) {
    if (String(err.message || '').includes('ACTION_CANCELLED_BY_POLICY')) {
      const cancelField = actionType === 'clock_in'
        ? { clock_in_status: 'cancelled', scheduled_clock_in: null }
        : { clock_out_status: 'cancelled', scheduled_clock_out: null };
      cacheManager.mergeDailySchedule({ date: todayStr, ...cancelField }, false);
      return { executed: false, cancelled: true, reason: 'ACTION_CANCELLED_BY_POLICY' };
    }
    console.error(`[SCHEDULER] Scheduled ${actionType} failed:`, err.message);
    return { executed: false, skipped: false, error: err.message };
  } finally {
    state.inFlightClaims.delete(gate.claimKey);
    if (state.inFlightExecution && state.inFlightExecution.jobId === meta.boundJobId) {
      state.inFlightExecution = null;
    }
  }
}

function armSingleActionCron(actionType, scheduleData, effectiveRevision, supabase) {
  const state = getSchedulerState();
  const isClockIn = actionType === 'clock_in';
  const timeStr = isClockIn ? scheduleData.scheduled_clock_in : scheduleData.scheduled_clock_out;
  if (!timeStr || typeof timeStr !== 'string' || !timeStr.includes(':')) return;

  const [hStr, mStr] = timeStr.split(':');
  const triggerTime = new Date();
  triggerTime.setHours(Number(hStr), Number(mStr), 0, 0);
  triggerTime.setMinutes(triggerTime.getMinutes() - 2);
  const cronH = triggerTime.getHours();
  const cronM = triggerTime.getMinutes();

  const jobIdKey = isClockIn ? 'clockInJobId' : 'clockOutJobId';
  const revKey = isClockIn ? 'clockInBoundRevision' : 'clockOutBoundRevision';
  const timeKey = isClockIn ? 'clockInTargetTime' : 'clockOutTargetTime';
  const dateKey = isClockIn ? 'clockInDate' : 'clockOutDate';
  const taskKey = isClockIn ? 'clockInTask' : 'clockOutTask';

  state[jobIdKey]++;
  const jobId = state[jobIdKey];
  state[revKey] = effectiveRevision;
  state[timeKey] = timeStr;
  state[dateKey] = scheduleData.date;

  if (isClockIn) {
    const diagTime = new Date();
    diagTime.setHours(Number(hStr), Number(mStr), 0, 0);
    diagTime.setMinutes(diagTime.getMinutes() - 25);
    if (diagTime.getTime() > Date.now()) {
      state.diagnosticJobId++;
      const diagJobId = state.diagnosticJobId;
      state.diagnosticTask = runtimeDependencies.cronSchedule(`${diagTime.getMinutes()} ${diagTime.getHours()} * * *`, async () => {
        if (diagJobId !== state.diagnosticJobId) return;
        if (scheduleData.date !== getLocalDateString()) return;
        try {
          await runPortalHealthDiagnostics(supabase, { deviceId: HOME_DEVICE_ID, scheduledTime: timeStr });
        } catch (err) {
          console.error('[SCHEDULER] Error during pre-flight diagnostics:', err.message);
        }
      });
    }
  }

  const triggerCallback = async () => {
    await executeGatedScheduledAction(actionType, {
      boundRevision: effectiveRevision,
      boundJobId: jobId,
      dateString: scheduleData.date,
      plannedTime: timeStr,
      source: 'scheduler'
    }, supabase);
  };

  const targetDateMs = buildLocalTargetDate(scheduleData.date, timeStr).getTime();
  if (triggerTime.getTime() <= Date.now() && Date.now() <= targetDateMs) {
    const immediateTimer = setTimeout(() => {
      if (jobId === state[jobIdKey]) triggerCallback();
    }, 10);
    if (typeof immediateTimer.unref === 'function') immediateTimer.unref();
    state[taskKey] = { stop: () => clearTimeout(immediateTimer) };
  } else {
    state[taskKey] = runtimeDependencies.cronSchedule(`${cronM} ${cronH} * * *`, triggerCallback);
  }
}

/**
 * Legacy helper maintained for compatibility with existing unit tests.
 */
function scheduleCronJobs(scheduleData, supabase) {
  stopCronJobs();
  if (!scheduleData || scheduleData.skipped) return;
  const state = getSchedulerState();
  const rev = scheduleData.policy_revision || state.currentAppliedRevision || 1;
  if (!scheduleData.clock_in_done && scheduleData.scheduled_clock_in) {
    armSingleActionCron('clock_in', scheduleData, rev, supabase);
  }
  if (!scheduleData.clock_out_done && scheduleData.scheduled_clock_out) {
    armSingleActionCron('clock_out', scheduleData, rev, supabase);
  }
}

async function checkMissedActions(scheduleData, supabase) {
  if (!scheduleData || scheduleData.skipped) return;

  const today = new Date();
  const dateString = getLocalDateString(today);
  if (scheduleData.date !== dateString) return;

  const proof = cacheManager.readCache().todays_proof;
  const proofIsForToday = proof && proof.date === dateString;
  const proofHasClockIn = proofIsForToday && isValidProofTime(proof.clock_in);
  const proofHasClockOut = proofIsForToday && isValidProofTime(proof.clock_out);
  const now = Date.now();

  if (scheduleData.scheduled_clock_in && !scheduleData.clock_in_done && scheduleData.clock_in_status !== 'missed_window') {
    const targetInTime = buildLocalTargetDate(dateString, scheduleData.scheduled_clock_in).getTime();
    if (!proofHasClockIn && now >= targetInTime && (now - targetInTime) <= GRACE_PERIOD_MS) {
      console.log('[SCHEDULER] RECOVERY: Missed Clock IN within grace window. Executing via gate...');
      const state = getSchedulerState();
      await executeGatedScheduledAction('clock_in', {
        boundRevision: scheduleData.policy_revision || state.currentAppliedRevision || 1,
        boundJobId: state.clockInJobId,
        dateString,
        plannedTime: scheduleData.scheduled_clock_in,
        source: 'recovery'
      }, supabase);
    } else if (proofHasClockIn && !scheduleData.clock_in_done) {
      await markProofSyncedFlag('clock_in', dateString, supabase);
    }
  }

  if (scheduleData.scheduled_clock_out && !scheduleData.clock_out_done && scheduleData.clock_out_status !== 'missed_window') {
    const targetOutTime = buildLocalTargetDate(dateString, scheduleData.scheduled_clock_out).getTime();
    if (!proofHasClockOut && now >= targetOutTime && (now - targetOutTime) <= GRACE_PERIOD_MS) {
      console.log('[SCHEDULER] RECOVERY: Missed Clock OUT within grace window. Executing via gate...');
      const state = getSchedulerState();
      await executeGatedScheduledAction('clock_out', {
        boundRevision: scheduleData.policy_revision || state.currentAppliedRevision || 1,
        boundJobId: state.clockOutJobId,
        dateString,
        plannedTime: scheduleData.scheduled_clock_out,
        source: 'recovery'
      }, supabase);
    } else if (proofHasClockOut && !scheduleData.clock_out_done) {
      await markProofSyncedFlag('clock_out', dateString, supabase);
    }
  }
}

async function markProofSyncedFlag(actionType, dateString, supabase) {
  const patch = actionType === 'clock_in'
    ? { clock_in_done: true, clock_in_status: 'completed' }
    : { clock_out_done: true, clock_out_status: 'completed' };
  try {
    if (supabase && typeof supabase.from === 'function') {
      await supabase.from('daily_schedules').update(patch).eq('date', dateString).or(`device_id.eq.${HOME_DEVICE_ID},device_id.is.null`);
    }
    cacheManager.mergeDailySchedule({ date: dateString, ...patch }, true);
  } catch (_) {
    cacheManager.mergeDailySchedule({ date: dateString, ...patch }, false);
  }
}

function computeActionStatus({ enabled, done, plannedTime, dateString, wasPreviouslyArmed, isInitialBoot, nowMs }) {
  if (done) return 'completed';
  if (!enabled) {
    return wasPreviouslyArmed ? 'cancelled' : 'disabled';
  }
  if (!plannedTime) return 'pending';
  const targetMs = buildLocalTargetDate(dateString, plannedTime).getTime();
  if (nowMs <= targetMs) return 'pending';
  if ((wasPreviouslyArmed || isInitialBoot) && (nowMs - targetMs) <= GRACE_PERIOD_MS) return 'pending';
  return 'missed_window';
}

function shouldRearmCronJob(existingTask, activeTargetTime, desiredTime, activeDate, desiredDate, status, done) {
  if (done || status !== 'pending' || !desiredTime) return false;
  if (!existingTask) return true;
  if (activeTargetTime !== desiredTime || activeDate !== desiredDate) return true;
  return false;
}

/**
 * Single centralized scheduling reconciler invoked by startup, midnight rollover,
 * Realtime policy updates, reconnect recovery, and sleep/resume events.
 */
async function performReconcile(supabase, options = {}) {
  const state = getSchedulerState();
  state.activeSupabase = supabase;

  if (options.eventRevision !== undefined && options.eventRevision !== null) {
    const evRev = Number(options.eventRevision) || 0;
    if (evRev > state.knownLatestRevision) {
      state.knownLatestRevision = evRev;
    }
    if (!options.force && evRev > 0 && evRev < state.currentAppliedRevision) {
      console.log(`[SCHEDULER] Ignoring obsolete event revision ${evRev} (current applied: ${state.currentAppliedRevision}).`);
      return { ignoredStale: true, revision: state.currentAppliedRevision };
    }
  }

  const identity = resolveRuntimeIdentity();
  const authCheck = isAuthorizedAutoScheduleIdentity(identity);

  if (!authCheck.allowed) {
    stopCronJobs();
    if (identity.deviceId !== HOME_DEVICE_ID || identity.edition !== 'full') {
      state.healthStatus = 'disabled';
      state.healthIssues = [];
      state.lastError = null;
      state.lastErrorCategory = null;
      return { skipped: true, authorized: false, reason: authCheck.reason, deviceId: identity.deviceId, edition: identity.edition };
    }
  }

  const today = new Date();
  const todayStr = getLocalDateString(today);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  state.lastReconcileAt = nowIso;
  state.lastReconcileTrigger = options.triggerSource || 'reconcile';
  state.lastEvaluatedDate = todayStr;

  const { policy, supabaseOnline, schemaReady } = await fetchAuthoritativePolicy(supabase, identity.deviceId);
  const effectiveRevision = Math.max(
    Number(policy.revision || 1),
    state.currentAppliedRevision
  );

  // If online returned a revision lower than a known realtime event, mark uncertain until fetched
  if (!supabaseOnline && state.knownLatestRevision > effectiveRevision) {
    state.policyUncertain = true;
  } else {
    state.policyUncertain = false;
  }

  const evalResult = authCheck.allowed
    ? evaluateDatePolicy(todayStr, policy)
    : {
        date: todayStr,
        effectiveMode: 'full_skip',
        clockInEnabled: false,
        clockOutEnabled: false,
        ruleSource: 'disabled',
        ruleLabel: authCheck.reason
      };

  const { existingSched, proof } = await fetchTodaysExistingRecords(supabase, todayStr, identity.deviceId);
  const proofHasClockIn = Boolean(proof && isValidProofTime(proof.clock_in));
  const proofHasClockOut = Boolean(proof && isValidProofTime(proof.clock_out));

  // Completion requires reliable DB flag or verified portal proof time (never assumed from click alone)
  const clockInDone = Boolean((existingSched && existingSched.clock_in_done) || proofHasClockIn);
  const clockOutDone = Boolean((existingSched && existingSched.clock_out_done) || proofHasClockOut);

  let plannedIn = existingSched && (existingSched.planned_clock_in || existingSched.scheduled_clock_in) || null;
  let plannedOut = existingSched && (existingSched.planned_clock_out || existingSched.scheduled_clock_out) || null;

  if (clockInDone && !plannedIn && proofHasClockIn) {
    plannedIn = String(proof.clock_in).trim().slice(0, 5);
  }
  if (clockOutDone && !plannedOut && proofHasClockOut) {
    plannedOut = String(proof.clock_out).trim().slice(0, 5);
  }

  if (evalResult.clockInEnabled && !clockInDone && !plannedIn) {
    plannedIn = generateRandomTimeStr(identity.deviceConfig.clock_in_base_time || '07:45', identity.deviceConfig.random_period_minutes);
  }
  if (evalResult.clockOutEnabled && !clockOutDone && !plannedOut) {
    plannedOut = generateRandomTimeStr(identity.deviceConfig.clock_out_base_time || '17:05', identity.deviceConfig.random_period_minutes);
  }

  const wasInArmed = Boolean(
    state.clockInTask ||
    (existingSched && existingSched.scheduled_clock_in && existingSched.clock_in_status !== 'cancelled' && existingSched.clock_in_status !== 'disabled')
  );
  const wasOutArmed = Boolean(
    state.clockOutTask ||
    (existingSched && existingSched.scheduled_clock_out && existingSched.clock_out_status !== 'cancelled' && existingSched.clock_out_status !== 'disabled')
  );

  const isInitialBoot = !existingSched && (
    options.triggerSource === 'startup' ||
    options.triggerSource === 'sleep_resume_detector' ||
    options.triggerSource === 'os_power_resume'
  );

  const clockInStatus = computeActionStatus({
    enabled: evalResult.clockInEnabled,
    done: clockInDone,
    plannedTime: plannedIn,
    dateString: todayStr,
    wasPreviouslyArmed: wasInArmed,
    isInitialBoot,
    nowMs
  });

  const clockOutStatus = computeActionStatus({
    enabled: evalResult.clockOutEnabled,
    done: clockOutDone,
    plannedTime: plannedOut,
    dateString: todayStr,
    wasPreviouslyArmed: wasOutArmed,
    isInitialBoot,
    nowMs
  });

  // Check if an active click is already underway for a now-disabled action
  let ackStatus = 'applied';
  let ackMessage = `Reconciled rev #${effectiveRevision} (${evalResult.effectiveMode}, source=${options.triggerSource || 'reconcile'})`;
  let cronError = null;

  const syncActionJob = ({ actionType, enabled, done, status, plannedTime }) => {
    const isClockIn = actionType === 'clock_in';
    const taskKey = isClockIn ? 'clockInTask' : 'clockOutTask';
    const timeKey = isClockIn ? 'clockInTargetTime' : 'clockOutTargetTime';
    const dateKey = isClockIn ? 'clockInDate' : 'clockOutDate';
    const revKey = isClockIn ? 'clockInBoundRevision' : 'clockOutBoundRevision';

    if (!enabled || done || status !== 'pending') {
      if (state.inFlightExecution && state.inFlightExecution.actionType === actionType) {
        state.inFlightExecution.aborted = true;
        if (state.inFlightExecution.stage === 'active_clicking') {
          ackStatus = 'warning_in_progress';
          ackMessage = `${isClockIn ? 'Clock-in' : 'Clock-out'} click already underway; could not guarantee mid-click cancellation.`;
        }
      }
      cancelActionCronJob(actionType);
    } else if (shouldRearmCronJob(state[taskKey], state[timeKey], plannedTime, state[dateKey], todayStr, status, done)) {
      cancelActionCronJob(actionType);
      try {
        armSingleActionCron(actionType, {
          date: todayStr,
          device_id: identity.deviceId,
          scheduled_clock_in: plannedIn,
          scheduled_clock_out: plannedOut
        }, effectiveRevision, supabase);
      } catch (armErr) {
        cronError = `Failed to register ${actionType} cron: ${armErr.message}`;
        console.error(`[SCHEDULER] ${cronError}`);
      }
    } else {
      state[revKey] = effectiveRevision;
    }
  };

  syncActionJob({ actionType: 'clock_in', enabled: evalResult.clockInEnabled, done: clockInDone, status: clockInStatus, plannedTime: plannedIn });
  syncActionJob({ actionType: 'clock_out', enabled: evalResult.clockOutEnabled, done: clockOutDone, status: clockOutStatus, plannedTime: plannedOut });

  const nextSchedulePayload = {
    date: todayStr,
    device_id: identity.deviceId,
    skipped: evalResult.effectiveMode === 'full_skip',
    effective_mode: evalResult.effectiveMode,
    scheduled_clock_in: evalResult.clockInEnabled ? plannedIn : (clockInDone ? (existingSched?.scheduled_clock_in || plannedIn) : null),
    scheduled_clock_out: evalResult.clockOutEnabled ? plannedOut : (clockOutDone ? (existingSched?.scheduled_clock_out || plannedOut) : null),
    planned_clock_in: plannedIn,
    planned_clock_out: plannedOut,
    clock_in_done: clockInDone,
    clock_out_done: clockOutDone,
    clock_in_status: clockInStatus,
    clock_out_status: clockOutStatus,
    policy_revision: effectiveRevision,
    rule_source: evalResult.ruleSource,
    updated_at: new Date().toISOString()
  };

  let scheduleSynced = false;
  let ackSynced = !schemaReady;
  if (supabaseOnline && supabase && typeof supabase.from === 'function') {
    try {
      let schedWriteRes = await supabase.from('daily_schedules').upsert(nextSchedulePayload, { onConflict: 'date, device_id' });
      if (schedWriteRes && schedWriteRes.error && isMissingSchemaError(schedWriteRes.error)) {
        // Fallback for older DB schema before column migration
        const legacyPayload = {
          date: todayStr,
          device_id: identity.deviceId,
          skipped: nextSchedulePayload.skipped,
          scheduled_clock_in: evalResult.clockInEnabled ? plannedIn : null,
          scheduled_clock_out: evalResult.clockOutEnabled ? plannedOut : null,
          clock_in_done: clockInDone,
          clock_out_done: clockOutDone
        };
        schedWriteRes = await supabase.from('daily_schedules').upsert(legacyPayload);
      }
      if (!schedWriteRes || !schedWriteRes.error) {
        scheduleSynced = true;
      }
    } catch (_) {}

    if (schemaReady) {
      try {
        const ackRes = await supabase
          .from('schedule_policy_state')
          .update({
            applied_revision: effectiveRevision,
            applied_at: new Date().toISOString(),
            ack_status: ackStatus,
            ack_message: ackMessage,
            scheduler_version: VERSION,
            effective_today_date: todayStr,
            effective_today_mode: evalResult.effectiveMode,
            effective_clock_in_status: clockInStatus,
            effective_clock_out_status: clockOutStatus,
            effective_rule_source: evalResult.ruleSource
          })
          .eq('device_id', identity.deviceId);
        if (ackRes && ackRes.error) {
          console.warn(`[SCHEDULER] Failed to acknowledge revision #${effectiveRevision} in Supabase:`, ackRes.error.message);
          ackSynced = false;
        } else {
          ackSynced = true;
        }
      } catch (ackErr) {
        console.warn(`[SCHEDULER] Exception acknowledging revision #${effectiveRevision}:`, ackErr.message);
        ackSynced = false;
      }
    }

    if (ackStatus === 'warning_in_progress') {
      try {
        await supabase.from('logs').insert({
          action: 'scheduler',
          status: 'warning',
          message: ackMessage,
          device_id: identity.deviceId
        });
      } catch (_) {}
    }
  }

  state.currentAppliedRevision = effectiveRevision;
  state.knownLatestRevision = Math.max(state.knownLatestRevision, effectiveRevision);
  state.scheduleWriteSynced = scheduleSynced;
  state.lastEvaluation = evalResult;
  state.lastSchedulePayload = nextSchedulePayload;

  cacheManager.mergeDailySchedule({ ...nextSchedulePayload, _allowResetDone: !existingSched }, scheduleSynced);
  if (typeof cacheManager.saveSchedulePolicy === 'function') {
    cacheManager.saveSchedulePolicy({
      ...policy,
      revision: effectiveRevision,
      applied_revision: effectiveRevision,
      applied_at: new Date().toISOString(),
      ack_status: ackStatus,
      ack_message: ackMessage,
      scheduler_version: VERSION,
      schema_ready: schemaReady
    }, supabaseOnline);
  }

  if (options.checkMissed) {
    await checkMissedActions(nextSchedulePayload, supabase);
  }

  // Evaluate schedule integrity & self-healing status
  const issues = validateTodayScheduleIntegrity({
    evalResult,
    schedule: nextSchedulePayload,
    state,
    todayStr,
    supabaseOnline,
    scheduleSynced,
    cronError
  });
  state.healthIssues = issues;

  if (cronError) {
    state.lastError = cronError;
    state.lastErrorCategory = 'generation_failure';
    state.healthStatus = 'unhealthy';
    scheduleBoundedRecoveryRetry(supabase, cronError);
  } else if (!supabaseOnline) {
    state.lastError = 'Supabase unreachable during schedule reconciliation (using local policy)';
    state.lastErrorCategory = 'retrieval_failure';
    state.healthStatus = 'degraded';
    scheduleBoundedRecoveryRetry(supabase, state.lastError);
  } else if (!scheduleSynced || !ackSynced) {
    state.lastError = !ackSynced
      ? `Revision #${effectiveRevision} applied locally, awaiting schedule_policy_state acknowledgement in Supabase`
      : 'Schedule computed locally, awaiting Supabase daily_schedules sync';
    state.lastErrorCategory = 'supabase_sync_delay';
    state.healthStatus = 'degraded';
    scheduleBoundedRecoveryRetry(supabase, state.lastError);
  } else if (issues.some(i => i.severity === 'error')) {
    state.lastError = issues.map(i => i.message).join('; ');
    state.lastErrorCategory = issues[0].category || 'generation_failure';
    state.healthStatus = 'unhealthy';
    scheduleBoundedRecoveryRetry(supabase, state.lastError);
  } else {
    state.lastError = null;
    state.lastErrorCategory = null;
    state.healthStatus = 'healthy';
    state.consecutiveFailures = 0;
    state.nextRetryAt = null;
    state.lastSuccessReconcileAt = nowIso;
    if (state.retryTimer) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
  }

  if (global.updateTrayTooltip) global.updateTrayTooltip();

  return {
    authorized: true,
    appliedRevision: effectiveRevision,
    ackStatus,
    ackMessage,
    supabaseOnline,
    schemaReady,
    scheduleSynced,
    healthStatus: state.healthStatus,
    healthIssues: issues,
    evaluation: evalResult,
    schedule: nextSchedulePayload,
    jobs: {
      clockInScheduled: Boolean(state.clockInTask),
      clockOutScheduled: Boolean(state.clockOutTask),
      diagnosticScheduled: Boolean(state.diagnosticTask)
    }
  };
}

function validateTodayScheduleIntegrity({ evalResult, schedule, state, todayStr, supabaseOnline = true, scheduleSynced = true, cronError = null }) {
  const issues = [];
  if (cronError) {
    issues.push({ code: 'CRON_REGISTRATION_FAILED', category: 'generation_failure', severity: 'error', message: cronError });
  }
  if (!schedule || schedule.date !== todayStr) {
    issues.push({ code: 'MISSING_DAILY_SCHEDULE', category: 'generation_failure', severity: 'error', message: `No schedule payload for ${todayStr}` });
    return issues;
  }
  if (evalResult && evalResult.clockInEnabled && !schedule.clock_in_done && schedule.clock_in_status === 'pending') {
    if (!schedule.scheduled_clock_in) {
      issues.push({ code: 'MISSING_CLOCK_IN_TIME', category: 'generation_failure', severity: 'error', message: 'Active clock-in has no scheduled time' });
    }
    if (!state.clockInTask) {
      issues.push({ code: 'CRON_JOB_NOT_REGISTERED', category: 'cron_job_missing', severity: 'error', message: 'Pending clock-in cron job is not registered in memory' });
    }
  }
  if (evalResult && evalResult.clockOutEnabled && !schedule.clock_out_done && schedule.clock_out_status === 'pending') {
    if (!schedule.scheduled_clock_out) {
      issues.push({ code: 'MISSING_CLOCK_OUT_TIME', category: 'generation_failure', severity: 'error', message: 'Active clock-out has no scheduled time' });
    }
    if (!state.clockOutTask) {
      issues.push({ code: 'CRON_JOB_NOT_REGISTERED', category: 'cron_job_missing', severity: 'error', message: 'Pending clock-out cron job is not registered in memory' });
    }
  }
  if (!supabaseOnline) {
    issues.push({ code: 'SUPABASE_OFFLINE', category: 'retrieval_failure', severity: 'warning', message: 'Supabase unavailable during sync' });
  } else if (!scheduleSynced) {
    issues.push({ code: 'SUPABASE_SYNC_DELAY', category: 'supabase_sync_delay', severity: 'warning', message: 'Local schedule not yet confirmed in Supabase' });
  }
  if (state.knownLatestRevision > state.currentAppliedRevision || state.policyUncertain) {
    issues.push({ code: 'REVISION_MISMATCH', category: 'supabase_sync_delay', severity: 'warning', message: `Applied rev #${state.currentAppliedRevision} behind latest #${state.knownLatestRevision}` });
  }
  return issues;
}

function scheduleBoundedRecoveryRetry(supabase, reason) {
  const state = getSchedulerState();
  if (process.env.NODE_ENV === 'test') return false;
  if (state.retryTimer) return true;
  if (state.consecutiveFailures >= MAX_BACKOFF_RETRIES) {
    state.nextRetryAt = null;
    return false;
  }

  state.consecutiveFailures += 1;
  const delayMs = Math.min(300000, 15000 * Math.pow(2, state.consecutiveFailures - 1));
  state.nextRetryAt = new Date(Date.now() + delayMs).toISOString();
  console.warn(`[SCHEDULER] Scheduling bounded recovery attempt ${state.consecutiveFailures}/${MAX_BACKOFF_RETRIES} in ${Math.round(delayMs / 1000)}s (${reason})...`);

  state.retryTimer = setTimeout(async () => {
    state.retryTimer = null;
    state.nextRetryAt = null;
    try {
      await reconcileSchedule(supabase, {
        triggerSource: `backoff_retry_${state.consecutiveFailures}`,
        checkMissed: true,
        force: true
      });
    } catch (err) {
      console.error('[SCHEDULER] Bounded recovery retry failed:', err.message);
    }
  }, delayMs);

  if (typeof state.retryTimer.unref === 'function') {
    state.retryTimer.unref();
  }
  return true;
}

async function runHealthCheck(supabase) {
  const state = getSchedulerState();
  state.lastHealthCheckAt = new Date().toISOString();

  const identity = resolveRuntimeIdentity();
  const authCheck = isAuthorizedAutoScheduleIdentity(identity);
  if (!authCheck.allowed) {
    state.healthStatus = 'disabled';
    state.healthIssues = [];
    return { healthy: true, disabled: true, status: 'disabled' };
  }

  const todayStr = getLocalDateString();
  const cache = cacheManager.readCache();
  const cachedSched = cache && cache.daily_schedule && cache.daily_schedule.date === todayStr ? cache.daily_schedule : null;
  const activeSched = (state.lastSchedulePayload && state.lastSchedulePayload.date === todayStr) ? state.lastSchedulePayload : cachedSched;
  const evalResult = state.lastEvaluation && state.lastEvaluation.date === todayStr
    ? state.lastEvaluation
    : evaluateDatePolicy(todayStr, cacheManager.getSchedulePolicy ? cacheManager.getSchedulePolicy() : {});

  const issues = [];
  if (!state.initialized) {
    issues.push({ code: 'SCHEDULER_NOT_INITIALIZED', category: 'generation_failure', severity: 'error', message: 'Scheduler has not completed initialization' });
  }
  if (state.lastEvaluatedDate && state.lastEvaluatedDate !== todayStr) {
    issues.push({ code: 'DATE_ROLLOVER_STALE', category: 'generation_failure', severity: 'error', message: `Date changed from ${state.lastEvaluatedDate} to ${todayStr}` });
  }
  issues.push(...validateTodayScheduleIntegrity({
    evalResult,
    schedule: activeSched,
    state,
    todayStr,
    supabaseOnline: global.connectivityState !== 'Offline',
    scheduleSynced: state.scheduleWriteSynced
  }));

  state.healthIssues = issues;
  const needsRecovery = issues.some(i => i.severity === 'error') || state.healthStatus === 'unhealthy' || state.knownLatestRevision > state.currentAppliedRevision;

  if (needsRecovery && supabase) {
    console.warn(`[SCHEDULER] Health monitor detected ${issues.map(i => i.code).join(', ') || state.healthStatus}; running self-healing reconciliation...`);
    const recRes = await reconcileSchedule(supabase, {
      triggerSource: 'health_monitor_self_heal',
      checkMissed: true,
      force: true
    });
    return { healthy: state.healthStatus === 'healthy', recovered: true, status: state.healthStatus, result: recRes };
  }

  return { healthy: state.healthStatus === 'healthy', recovered: false, status: state.healthStatus, issues };
}

function startHealthMonitor(supabase) {
  const state = getSchedulerState();
  if (state.healthTimer) {
    clearInterval(state.healthTimer);
  }
  state.healthTimer = setInterval(() => {
    runHealthCheck(supabase).catch((err) => {
      console.error('[SCHEDULER] Periodic health check error:', err.message);
    });
  }, HEALTH_CHECK_INTERVAL_MS);
  if (typeof state.healthTimer.unref === 'function') {
    state.healthTimer.unref();
  }
}

function reconcileSchedule(supabase, options = {}) {
  const state = getSchedulerState();
  state.reconcileChain = state.reconcileChain
    .catch(() => {})
    .then(async () => {
      try {
        return await performReconcile(supabase, options);
      } catch (err) {
        state.lastError = err.message || String(err);
        state.lastErrorCategory = 'generation_failure';
        state.healthStatus = 'unhealthy';
        state.healthIssues = [{ code: 'RECONCILE_EXCEPTION', category: 'generation_failure', severity: 'error', message: state.lastError }];
        scheduleBoundedRecoveryRetry(supabase, state.lastError);
        throw err;
      }
    });
  return state.reconcileChain;
}

function notifyIncomingRevision(revision) {
  const state = getSchedulerState();
  const rev = Number(revision) || 0;
  if (rev > state.knownLatestRevision) {
    state.knownLatestRevision = rev;
  }
}

function startSleepResumeDetector(supabase) {
  const state = getSchedulerState();
  if (state.sleepDetectorTimer) {
    clearInterval(state.sleepDetectorTimer);
  }
  state.lastWallClockMs = Date.now();
  state.sleepDetectorTimer = setInterval(() => {
    const now = Date.now();
    const elapsed = now - state.lastWallClockMs;
    state.lastWallClockMs = now;
    const todayStr = getLocalDateString();
    if (elapsed > SLEEP_JUMP_THRESHOLD_MS || (state.lastEvaluatedDate && state.lastEvaluatedDate !== todayStr)) {
      console.log(`[SCHEDULER] Detected wall-clock jump (${Math.round(elapsed / 1000)}s) or date rollover, triggering reconciliation...`);
      reconcileSchedule(supabase, { triggerSource: elapsed > SLEEP_JUMP_THRESHOLD_MS ? 'sleep_resume_detector' : 'date_rollover_detector', checkMissed: true, force: true });
    }
  }, 15000);
  if (typeof state.sleepDetectorTimer.unref === 'function') {
    state.sleepDetectorTimer.unref();
  }
}

async function init(supabase) {
  const state = getSchedulerState();
  state.activeSupabase = supabase;
  state.initAttempts += 1;

  let result = null;
  try {
    result = await reconcileSchedule(supabase, {
      triggerSource: 'startup',
      checkMissed: true,
      force: true
    });
  } catch (err) {
    state.lastError = err.message || String(err);
    state.lastErrorCategory = 'generation_failure';
    state.healthStatus = 'unhealthy';
    console.error('[SCHEDULER] Initial reconcile failed:', state.lastError);
    scheduleBoundedRecoveryRetry(supabase, state.lastError);
  } finally {
    state.initialized = true;
  }

  if (global.midnightTask) {
    try { global.midnightTask.stop(); } catch (_) {}
  }

  global.midnightTask = runtimeDependencies.cronSchedule('0 0 * * *', async () => {
    try {
      await reconcileSchedule(supabase, { triggerSource: 'midnight_rollover', force: true });
    } catch (err) {
      console.error('[SCHEDULER] Midnight schedule generation failed, will retry:', err.message);
      scheduleBoundedRecoveryRetry(supabase, `midnight_rollover: ${err.message}`);
    }
  });

  if (process.env.NODE_ENV !== 'test') {
    startSleepResumeDetector(supabase);
    startHealthMonitor(supabase);
  }

  return result;
}

function stop() {
  const state = getSchedulerState();
  if (global.midnightTask) {
    try { global.midnightTask.stop(); } catch (_) {}
    global.midnightTask = null;
  }
  if (state.sleepDetectorTimer) {
    clearInterval(state.sleepDetectorTimer);
    state.sleepDetectorTimer = null;
  }
  if (state.healthTimer) {
    clearInterval(state.healthTimer);
    state.healthTimer = null;
  }
  if (state.retryTimer) {
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }
  state.nextRetryAt = null;
  stopCronJobs();
}

function getRuntimeSnapshot() {
  const state = getSchedulerState();
  return {
    version: VERSION,
    initialized: state.initialized,
    healthStatus: state.healthStatus,
    healthIssues: [...(state.healthIssues || [])],
    lastError: state.lastError,
    lastErrorCategory: state.lastErrorCategory,
    lastReconcileAt: state.lastReconcileAt,
    lastSuccessReconcileAt: state.lastSuccessReconcileAt,
    lastReconcileTrigger: state.lastReconcileTrigger,
    lastEvaluatedDate: state.lastEvaluatedDate,
    lastHealthCheckAt: state.lastHealthCheckAt,
    consecutiveFailures: state.consecutiveFailures,
    nextRetryAt: state.nextRetryAt,
    scheduleWriteSynced: state.scheduleWriteSynced,
    currentAppliedRevision: state.currentAppliedRevision,
    knownLatestRevision: state.knownLatestRevision,
    policyUncertain: state.policyUncertain,
    clockInScheduled: Boolean(state.clockInTask),
    clockOutScheduled: Boolean(state.clockOutTask),
    diagnosticScheduled: Boolean(state.diagnosticTask),
    clockInTargetTime: state.clockInTargetTime,
    clockOutTargetTime: state.clockOutTargetTime,
    clockInBoundRevision: state.clockInBoundRevision,
    clockOutBoundRevision: state.clockOutBoundRevision,
    clockInJobId: state.clockInJobId,
    clockOutJobId: state.clockOutJobId,
    inFlightExecution: state.inFlightExecution ? { ...state.inFlightExecution } : null
  };
}

function getDiagnosticsSnapshot() {
  const state = getSchedulerState();
  const todayStr = getLocalDateString();
  const sched = (state.lastSchedulePayload && state.lastSchedulePayload.date === todayStr) ? state.lastSchedulePayload : null;
  const evalRes = (state.lastEvaluation && state.lastEvaluation.date === todayStr) ? state.lastEvaluation : null;

  return {
    ...getRuntimeSnapshot(),
    todayDate: todayStr,
    effectiveMode: (sched && sched.effective_mode) || (evalRes && evalRes.effectiveMode) || null,
    ruleSource: (sched && sched.rule_source) || (evalRes && evalRes.ruleSource) || null,
    ruleLabel: (evalRes && evalRes.ruleLabel) || null,
    clockIn: {
      status: sched ? sched.clock_in_status : null,
      scheduledTime: sched ? sched.scheduled_clock_in : state.clockInTargetTime,
      done: Boolean(sched && sched.clock_in_done),
      cronRegistered: Boolean(state.clockInTask),
      boundRevision: state.clockInBoundRevision,
      jobId: state.clockInJobId
    },
    clockOut: {
      status: sched ? sched.clock_out_status : null,
      scheduledTime: sched ? sched.scheduled_clock_out : state.clockOutTargetTime,
      done: Boolean(sched && sched.clock_out_done),
      cronRegistered: Boolean(state.clockOutTask),
      boundRevision: state.clockOutBoundRevision,
      jobId: state.clockOutJobId
    }
  };
}

function resetSchedulerStateForTest() {
  stop();
  const state = getSchedulerState();
  state.clockInJobId = 0;
  state.clockOutJobId = 0;
  state.diagnosticJobId = 0;
  state.clockInBoundRevision = 0;
  state.clockOutBoundRevision = 0;
  state.clockInTargetTime = null;
  state.clockOutTargetTime = null;
  state.clockInDate = null;
  state.clockOutDate = null;
  state.currentAppliedRevision = 0;
  state.knownLatestRevision = 0;
  state.policyUncertain = false;
  state.inFlightClaims.clear();
  state.inFlightExecution = null;
  state.reconcileChain = Promise.resolve();
  state.initialized = false;
  state.initAttempts = 0;
  state.consecutiveFailures = 0;
  state.lastReconcileAt = null;
  state.lastSuccessReconcileAt = null;
  state.lastReconcileTrigger = null;
  state.lastError = null;
  state.lastErrorCategory = null;
  state.lastEvaluatedDate = null;
  state.lastHealthCheckAt = null;
  state.healthStatus = 'initializing';
  state.healthIssues = [];
  state.nextRetryAt = null;
  state.scheduleWriteSynced = false;
  state.lastEvaluation = null;
  state.lastSchedulePayload = null;
}

module.exports = {
  VERSION,
  HOME_DEVICE_ID,
  VALID_DAY_MODES,
  init,
  stop,
  reconcileSchedule,
  runHealthCheck,
  notifyIncomingRevision,
  evaluateDatePolicy,
  evaluateCalendarRange,
  expandBulkDates,
  matchesRecurringRule,
  modeCapabilities,
  verifyPreExecutionGate,
  runPortalHealthDiagnostics,
  getRuntimeSnapshot,
  getDiagnosticsSnapshot,
  __test: {
    buildLocalTargetDate,
    generateRandomTimeStr,
    scheduleCronJobs,
    checkMissedActions,
    runPortalHealthDiagnostics,
    executeGatedScheduledAction,
    validateTodayScheduleIntegrity,
    scheduleBoundedRecoveryRetry,
    setRuntimeDependenciesForTest,
    resetRuntimeDependencies,
    resetSchedulerStateForTest,
    getSchedulerState,
    stopCronJobs
  }
};
