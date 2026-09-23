-- Migration: Fix Unique Constraints for Multi-Device Hub
-- Description: Drops the single-user date unique constraints and replaces them with composite unique constraints (date, device_id) so the Hub can manage multiple users' data for the same day.

DO $$
DECLARE
    r RECORD;
BEGIN
    -- 1. Drop old unique constraints on todays_proof
    FOR r IN (
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'public.todays_proof'::regclass AND contype = 'u'
    ) LOOP
        EXECUTE 'ALTER TABLE public.todays_proof DROP CONSTRAINT ' || quote_ident(r.conname);
    END LOOP;
    
    -- 2. Drop old unique constraints on daily_schedules
    FOR r IN (
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'public.daily_schedules'::regclass AND contype = 'u'
    ) LOOP
        EXECUTE 'ALTER TABLE public.daily_schedules DROP CONSTRAINT ' || quote_ident(r.conname);
    END LOOP;

    -- 3. Drop old unique constraints on skip_days
    FOR r IN (
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'public.skip_days'::regclass AND contype = 'u'
    ) LOOP
        EXECUTE 'ALTER TABLE public.skip_days DROP CONSTRAINT ' || quote_ident(r.conname);
    END LOOP;
END $$;

-- 4. Re-add composite unique constraints
ALTER TABLE public.todays_proof ADD CONSTRAINT todays_proof_date_device_id_key UNIQUE (date, device_id);
ALTER TABLE public.daily_schedules ADD CONSTRAINT daily_schedules_date_device_id_key UNIQUE (date, device_id);
ALTER TABLE public.skip_days ADD CONSTRAINT skip_days_date_device_id_key UNIQUE (date, device_id);
