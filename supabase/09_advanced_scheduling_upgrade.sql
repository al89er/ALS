-- Reference copy of supabase/migrations/20261118100000_advanced_scheduling_and_skip_upgrade.sql
-- Migration: Advanced Scheduling & Skip Dates Upgrade
-- Description: Replaces basic boolean skip_days with 4-mode day controls,
-- configurable weekly defaults, recurring rules, Malaysian public holidays,
-- non-destructive daily_schedules extensions, durable policy revisions,
-- desktop scheduler acknowledgement tracking, atomic bulk RPC, and strict RLS
-- restricted exclusively to the authorized home_desktop_agent account.

-- ============================================================================
-- 1. Policy State, Revision & Desktop Acknowledgement Table (home_desktop_agent only)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.schedule_policy_state (
  device_id TEXT PRIMARY KEY DEFAULT 'home_desktop_agent',
  user_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  revision BIGINT NOT NULL DEFAULT 1,
  weekly_defaults JSONB NOT NULL DEFAULT '{"0":"full_skip","1":"normal","2":"normal","3":"normal","4":"normal","5":"normal","6":"full_skip"}'::jsonb,
  last_change_source TEXT NOT NULL DEFAULT 'system',
  last_change_summary TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_revision BIGINT NOT NULL DEFAULT 0,
  applied_at TIMESTAMPTZ,
  ack_status TEXT NOT NULL DEFAULT 'pending' CHECK (ack_status IN ('pending', 'applied', 'warning_in_progress', 'error', 'unsupported_version')),
  ack_message TEXT,
  scheduler_version TEXT,
  effective_today_date TEXT,
  effective_today_mode TEXT CHECK (effective_today_mode IS NULL OR effective_today_mode IN ('normal', 'full_skip', 'clock_in_only', 'clock_out_only')),
  effective_clock_in_status TEXT,
  effective_clock_out_status TEXT,
  effective_rule_source TEXT,
  CONSTRAINT schedule_policy_state_home_only CHECK (device_id = 'home_desktop_agent')
);

CREATE INDEX IF NOT EXISTS idx_schedule_policy_state_user_id ON public.schedule_policy_state(user_id);

-- ============================================================================
-- 2. Date-Specific Overrides (Replaces simple skip_days while keeping legacy rows)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.schedule_date_overrides (
  date TEXT NOT NULL,
  device_id TEXT NOT NULL DEFAULT 'home_desktop_agent',
  user_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('normal', 'full_skip', 'clock_in_only', 'clock_out_only')),
  reason TEXT,
  source TEXT NOT NULL DEFAULT 'manual_override' CHECK (source IN ('manual_override', 'bulk_override', 'quick_control', 'approved_holiday', 'legacy_skip_day')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (date, device_id),
  CONSTRAINT schedule_date_overrides_date_fmt CHECK (date ~ '^\d{4}-\d{2}-\d{2}$'),
  CONSTRAINT schedule_date_overrides_home_only CHECK (device_id = 'home_desktop_agent')
);

CREATE INDEX IF NOT EXISTS idx_schedule_date_overrides_user_id ON public.schedule_date_overrides(user_id);
CREATE INDEX IF NOT EXISTS idx_schedule_date_overrides_device_date ON public.schedule_date_overrides(device_id, date);

-- ============================================================================
-- 3. Recurring Scheduling Rules (Weekly & Monthly with bounded evaluation)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.schedule_recurring_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id TEXT NOT NULL DEFAULT 'home_desktop_agent',
  user_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  recurrence_type TEXT NOT NULL CHECK (recurrence_type IN ('weekly', 'monthly_nth_weekday', 'monthly_day')),
  day_of_week SMALLINT CHECK (day_of_week IS NULL OR (day_of_week >= 0 AND day_of_week <= 6)),
  nth_week SMALLINT CHECK (nth_week IS NULL OR nth_week IN (1, 2, 3, 4, -1)),
  day_of_month SMALLINT CHECK (day_of_month IS NULL OR (day_of_month >= 1 AND day_of_month <= 31)),
  mode TEXT NOT NULL CHECK (mode IN ('normal', 'full_skip', 'clock_in_only', 'clock_out_only')),
  priority INTEGER NOT NULL DEFAULT 50,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT schedule_recurring_rules_from_fmt CHECK (effective_from ~ '^\d{4}-\d{2}-\d{2}$'),
  CONSTRAINT schedule_recurring_rules_to_fmt CHECK (effective_to IS NULL OR effective_to ~ '^\d{4}-\d{2}-\d{2}$'),
  CONSTRAINT schedule_recurring_rules_home_only CHECK (device_id = 'home_desktop_agent')
);

CREATE INDEX IF NOT EXISTS idx_schedule_recurring_rules_user_id ON public.schedule_recurring_rules(user_id);
CREATE INDEX IF NOT EXISTS idx_schedule_recurring_rules_device_enabled ON public.schedule_recurring_rules(device_id, enabled, priority DESC);

-- ============================================================================
-- 4. Public Holiday Management (Distinguishes imported vs approved holidays)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.schedule_holidays (
  date TEXT NOT NULL,
  device_id TEXT NOT NULL DEFAULT 'home_desktop_agent',
  user_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  state_scope TEXT NOT NULL DEFAULT 'National',
  mode TEXT NOT NULL DEFAULT 'full_skip' CHECK (mode IN ('normal', 'full_skip', 'clock_in_only', 'clock_out_only')),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'preset_malaysia', 'imported')),
  approved BOOLEAN NOT NULL DEFAULT false,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (date, device_id),
  CONSTRAINT schedule_holidays_date_fmt CHECK (date ~ '^\d{4}-\d{2}-\d{2}$'),
  CONSTRAINT schedule_holidays_home_only CHECK (device_id = 'home_desktop_agent')
);

CREATE INDEX IF NOT EXISTS idx_schedule_holidays_user_id ON public.schedule_holidays(user_id);
CREATE INDEX IF NOT EXISTS idx_schedule_holidays_device_approved ON public.schedule_holidays(device_id, approved, date);

-- ============================================================================
-- 5. Expand daily_schedules Non-Destructively
-- ============================================================================
ALTER TABLE IF EXISTS public.daily_schedules
  ADD COLUMN IF NOT EXISTS effective_mode TEXT DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS clock_in_status TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS clock_out_status TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS planned_clock_in TEXT,
  ADD COLUMN IF NOT EXISTS planned_clock_out TEXT,
  ADD COLUMN IF NOT EXISTS policy_revision BIGINT DEFAULT 1,
  ADD COLUMN IF NOT EXISTS rule_source TEXT DEFAULT 'system_default',
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

UPDATE public.daily_schedules
SET
  planned_clock_in = COALESCE(planned_clock_in, scheduled_clock_in),
  planned_clock_out = COALESCE(planned_clock_out, scheduled_clock_out),
  effective_mode = CASE WHEN skipped IS TRUE THEN 'full_skip' ELSE COALESCE(effective_mode, 'normal') END,
  clock_in_status = CASE
    WHEN clock_in_done IS TRUE THEN 'completed'
    WHEN skipped IS TRUE THEN 'disabled'
    ELSE COALESCE(clock_in_status, 'pending')
  END,
  clock_out_status = CASE
    WHEN clock_out_done IS TRUE THEN 'completed'
    WHEN skipped IS TRUE THEN 'disabled'
    ELSE COALESCE(clock_out_status, 'pending')
  END
WHERE planned_clock_in IS NULL OR planned_clock_out IS NULL OR effective_mode IS NULL;

-- ============================================================================
-- 6. Migrate Existing Legacy skip_days Records Non-Destructively
-- ============================================================================
DO $$
DECLARE
  home_uid UUID;
BEGIN
  SELECT id INTO home_uid FROM auth.users WHERE email = 'muhammadafif@upm.edu.my' LIMIT 1;

  IF home_uid IS NOT NULL THEN
    INSERT INTO public.schedule_policy_state (device_id, user_id, revision, last_change_source, last_change_summary)
    VALUES ('home_desktop_agent', home_uid, 1, 'migration', 'Initialized advanced scheduling policy from legacy defaults')
    ON CONFLICT (device_id) DO NOTHING;

    IF to_regclass('public.skip_days') IS NOT NULL THEN
      INSERT INTO public.schedule_date_overrides (date, device_id, user_id, mode, reason, source)
      SELECT
        s.date,
        'home_desktop_agent',
        COALESCE(s.user_id, home_uid),
        'full_skip',
        'Migrated from legacy skip_days',
        'legacy_skip_day'
      FROM public.skip_days s
      WHERE (s.device_id = 'home_desktop_agent' OR s.device_id IS NULL)
        AND s.date ~ '^\d{4}-\d{2}-\d{2}$'
      ON CONFLICT (date, device_id) DO NOTHING;
    END IF;
  END IF;
END $$;

-- ============================================================================
-- 7. Strict RLS Policies (Authorized home_desktop_agent owner only)
-- ============================================================================
ALTER TABLE public.schedule_policy_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedule_date_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedule_recurring_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedule_holidays ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Home agent owner can manage schedule_policy_state" ON public.schedule_policy_state;
CREATE POLICY "Home agent owner can manage schedule_policy_state"
ON public.schedule_policy_state
FOR ALL
TO authenticated
USING (
  (select auth.uid()) = user_id
  AND (select auth.jwt() ->> 'email') = 'muhammadafif@upm.edu.my'
  AND device_id = 'home_desktop_agent'
)
WITH CHECK (
  (select auth.uid()) = user_id
  AND (select auth.jwt() ->> 'email') = 'muhammadafif@upm.edu.my'
  AND device_id = 'home_desktop_agent'
);

DROP POLICY IF EXISTS "Home agent owner can manage schedule_date_overrides" ON public.schedule_date_overrides;
CREATE POLICY "Home agent owner can manage schedule_date_overrides"
ON public.schedule_date_overrides
FOR ALL
TO authenticated
USING (
  (select auth.uid()) = user_id
  AND (select auth.jwt() ->> 'email') = 'muhammadafif@upm.edu.my'
  AND device_id = 'home_desktop_agent'
)
WITH CHECK (
  (select auth.uid()) = user_id
  AND (select auth.jwt() ->> 'email') = 'muhammadafif@upm.edu.my'
  AND device_id = 'home_desktop_agent'
);

DROP POLICY IF EXISTS "Home agent owner can manage schedule_recurring_rules" ON public.schedule_recurring_rules;
CREATE POLICY "Home agent owner can manage schedule_recurring_rules"
ON public.schedule_recurring_rules
FOR ALL
TO authenticated
USING (
  (select auth.uid()) = user_id
  AND (select auth.jwt() ->> 'email') = 'muhammadafif@upm.edu.my'
  AND device_id = 'home_desktop_agent'
)
WITH CHECK (
  (select auth.uid()) = user_id
  AND (select auth.jwt() ->> 'email') = 'muhammadafif@upm.edu.my'
  AND device_id = 'home_desktop_agent'
);

DROP POLICY IF EXISTS "Home agent owner can manage schedule_holidays" ON public.schedule_holidays;
CREATE POLICY "Home agent owner can manage schedule_holidays"
ON public.schedule_holidays
FOR ALL
TO authenticated
USING (
  (select auth.uid()) = user_id
  AND (select auth.jwt() ->> 'email') = 'muhammadafif@upm.edu.my'
  AND device_id = 'home_desktop_agent'
)
WITH CHECK (
  (select auth.uid()) = user_id
  AND (select auth.jwt() ->> 'email') = 'muhammadafif@upm.edu.my'
  AND device_id = 'home_desktop_agent'
);

DROP POLICY IF EXISTS "Users can manage their own skip_days" ON public.skip_days;
CREATE POLICY "Users can manage their own skip_days"
ON public.skip_days
FOR ALL
TO authenticated
USING (
  (
    (select auth.uid()) = user_id
    AND (device_id IS DISTINCT FROM 'home_desktop_agent' OR (select auth.jwt() ->> 'email') = 'muhammadafif@upm.edu.my')
  )
  OR (select auth.jwt() ->> 'email') = 'muhammadafif@upm.edu.my'
)
WITH CHECK (
  (
    (select auth.uid()) = user_id
    AND (device_id IS DISTINCT FROM 'home_desktop_agent' OR (select auth.jwt() ->> 'email') = 'muhammadafif@upm.edu.my')
  )
  OR (
    (select auth.jwt() ->> 'email') = 'muhammadafif@upm.edu.my'
  )
);

-- ============================================================================
-- 8. Revision Bump Trigger & Atomic Bulk Operations RPC
-- ============================================================================
CREATE OR REPLACE FUNCTION public.bump_schedule_policy_revision()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_uid UUID;
BEGIN
  IF pg_trigger_depth() > 1 OR current_setting('als.skip_bump_trigger', true) = 'on' THEN
    RETURN NULL;
  END IF;

  IF TG_LEVEL = 'ROW' THEN
    IF TG_OP = 'DELETE' THEN
      IF OLD.device_id IS NOT NULL AND OLD.device_id <> 'home_desktop_agent' THEN
        RETURN OLD;
      END IF;
      v_uid := COALESCE((select auth.uid()), OLD.user_id);
    ELSE
      IF NEW.device_id IS NOT NULL AND NEW.device_id <> 'home_desktop_agent' THEN
        RETURN NEW;
      END IF;
      v_uid := COALESCE((select auth.uid()), NEW.user_id);
    END IF;
  ELSE
    v_uid := (select auth.uid());
  END IF;

  IF v_uid IS NOT NULL THEN
    INSERT INTO public.schedule_policy_state (
      device_id,
      user_id,
      revision,
      last_change_source,
      last_change_summary,
      updated_at
    )
    VALUES (
      'home_desktop_agent',
      v_uid,
      2,
      TG_TABLE_NAME || '_' || lower(TG_OP),
      'Updated via ' || TG_TABLE_NAME,
      now()
    )
    ON CONFLICT (device_id) DO UPDATE
    SET
      revision = public.schedule_policy_state.revision + 1,
      last_change_source = TG_TABLE_NAME || '_' || lower(TG_OP),
      last_change_summary = 'Updated via ' || TG_TABLE_NAME,
      updated_at = now();
  ELSE
    UPDATE public.schedule_policy_state
    SET
      revision = revision + 1,
      last_change_source = TG_TABLE_NAME || '_' || lower(TG_OP),
      last_change_summary = 'Updated via ' || TG_TABLE_NAME,
      updated_at = now()
    WHERE device_id = 'home_desktop_agent';
  END IF;

  IF TG_LEVEL = 'ROW' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_bump_rev_overrides ON public.schedule_date_overrides;
CREATE TRIGGER trg_bump_rev_overrides
AFTER INSERT OR UPDATE OR DELETE ON public.schedule_date_overrides
FOR EACH STATEMENT
EXECUTE FUNCTION public.bump_schedule_policy_revision();

DROP TRIGGER IF EXISTS trg_bump_rev_recurring ON public.schedule_recurring_rules;
CREATE TRIGGER trg_bump_rev_recurring
AFTER INSERT OR UPDATE OR DELETE ON public.schedule_recurring_rules
FOR EACH STATEMENT
EXECUTE FUNCTION public.bump_schedule_policy_revision();

DROP TRIGGER IF EXISTS trg_bump_rev_holidays ON public.schedule_holidays;
CREATE TRIGGER trg_bump_rev_holidays
AFTER INSERT OR UPDATE OR DELETE ON public.schedule_holidays
FOR EACH STATEMENT
EXECUTE FUNCTION public.bump_schedule_policy_revision();

DROP TRIGGER IF EXISTS trg_bump_rev_skip_days ON public.skip_days;
CREATE TRIGGER trg_bump_rev_skip_days
AFTER INSERT OR UPDATE OR DELETE ON public.skip_days
FOR EACH ROW
EXECUTE FUNCTION public.bump_schedule_policy_revision();

CREATE OR REPLACE FUNCTION public.save_bulk_schedule_overrides(
  p_dates TEXT[],
  p_mode TEXT,
  p_reason TEXT DEFAULT NULL,
  p_source TEXT DEFAULT 'bulk_override',
  p_clear BOOLEAN DEFAULT false
)
RETURNS TABLE (new_revision BIGINT, affected_count INTEGER)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_uid UUID;
  v_email TEXT;
  v_date TEXT;
  v_count INTEGER := 0;
  v_rev BIGINT;
BEGIN
  v_uid := (select auth.uid());
  v_email := (select auth.jwt() ->> 'email');

  IF v_uid IS NULL OR v_email IS DISTINCT FROM 'muhammadafif@upm.edu.my' THEN
    RAISE EXCEPTION 'Unauthorized: only home_desktop_agent owner may modify advanced scheduling policies';
  END IF;

  IF p_dates IS NULL OR array_length(p_dates, 1) IS NULL THEN
    RAISE EXCEPTION 'At least one target date is required';
  END IF;

  IF NOT p_clear AND p_mode NOT IN ('normal', 'full_skip', 'clock_in_only', 'clock_out_only') THEN
    RAISE EXCEPTION 'Invalid scheduling mode: %', p_mode;
  END IF;

  IF p_source NOT IN ('manual_override', 'bulk_override', 'quick_control', 'approved_holiday', 'legacy_skip_day') THEN
    RAISE EXCEPTION 'Invalid override source: %', p_source;
  END IF;

  PERFORM set_config('als.skip_bump_trigger', 'on', true);

  FOREACH v_date IN ARRAY p_dates LOOP
    IF v_date !~ '^\d{4}-\d{2}-\d{2}$' THEN
      RAISE EXCEPTION 'Invalid date format (expected YYYY-MM-DD): %', v_date;
    END IF;

    IF p_clear THEN
      DELETE FROM public.schedule_date_overrides
      WHERE date = v_date AND device_id = 'home_desktop_agent';

      DELETE FROM public.skip_days
      WHERE date = v_date AND (device_id = 'home_desktop_agent' OR device_id IS NULL);
    ELSE
      INSERT INTO public.schedule_date_overrides (date, device_id, user_id, mode, reason, source, updated_at)
      VALUES (v_date, 'home_desktop_agent', v_uid, p_mode, p_reason, p_source, now())
      ON CONFLICT (date, device_id) DO UPDATE
      SET
        mode = EXCLUDED.mode,
        reason = EXCLUDED.reason,
        source = EXCLUDED.source,
        user_id = v_uid,
        updated_at = now();

      IF p_mode = 'full_skip' THEN
        INSERT INTO public.skip_days (date, device_id, user_id)
        VALUES (v_date, 'home_desktop_agent', v_uid)
        ON CONFLICT (date, device_id) DO NOTHING;
      ELSE
        DELETE FROM public.skip_days
        WHERE date = v_date AND (device_id = 'home_desktop_agent' OR device_id IS NULL);
      END IF;
    END IF;

    v_count := v_count + 1;
  END LOOP;

  INSERT INTO public.schedule_policy_state (
    device_id,
    user_id,
    revision,
    last_change_source,
    last_change_summary,
    updated_at
  )
  VALUES (
    'home_desktop_agent',
    v_uid,
    2,
    p_source,
    COALESCE(p_reason, CASE WHEN p_clear THEN 'Cleared ' ELSE 'Applied ' || p_mode || ' to ' END || v_count || ' date(s)'),
    now()
  )
  ON CONFLICT (device_id) DO UPDATE
  SET
    revision = public.schedule_policy_state.revision + 1,
    last_change_source = p_source,
    last_change_summary = COALESCE(p_reason, CASE WHEN p_clear THEN 'Cleared ' ELSE 'Applied ' || p_mode || ' to ' END || v_count || ' date(s)'),
    updated_at = now()
  RETURNING revision INTO v_rev;

  PERFORM set_config('als.skip_bump_trigger', 'off', true);

  RETURN QUERY SELECT v_rev, v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.save_bulk_schedule_overrides(TEXT[], TEXT, TEXT, TEXT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_bulk_schedule_overrides(TEXT[], TEXT, TEXT, TEXT, BOOLEAN) TO authenticated;

-- ============================================================================
-- 9. Ensure Realtime Publication Covers Scheduling & Daily Schedule Tables
-- ============================================================================
DO $$
DECLARE
  tbl TEXT;
  tbls TEXT[] := ARRAY[
    'schedule_policy_state',
    'schedule_date_overrides',
    'schedule_recurring_rules',
    'schedule_holidays',
    'daily_schedules',
    'skip_days'
  ];
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH tbl IN ARRAY tbls LOOP
      IF to_regclass('public.' || tbl) IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
           FROM pg_publication_tables
           WHERE pubname = 'supabase_realtime'
             AND schemaname = 'public'
             AND tablename = tbl
         ) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', tbl);
      END IF;
    END LOOP;
  END IF;
END $$;
