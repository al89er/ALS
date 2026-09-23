-- Migration: Fix Primary Keys for Multi-Device Hub
-- Description: Drops the single-user date PRIMARY KEY constraints and replaces them with composite PRIMARY KEY constraints (date, device_id).

DO $$
BEGIN
    -- 1. todays_proof
    ALTER TABLE public.todays_proof DROP CONSTRAINT IF EXISTS todays_proof_pkey;
    ALTER TABLE public.todays_proof ADD PRIMARY KEY (date, device_id);
    
    -- 2. daily_schedules
    ALTER TABLE public.daily_schedules DROP CONSTRAINT IF EXISTS daily_schedules_pkey;
    ALTER TABLE public.daily_schedules ADD PRIMARY KEY (date, device_id);
    
    -- 3. skip_days
    ALTER TABLE public.skip_days DROP CONSTRAINT IF EXISTS skip_days_pkey;
    ALTER TABLE public.skip_days ADD PRIMARY KEY (date, device_id);

EXCEPTION
    WHEN others THEN
        RAISE NOTICE 'An error occurred, possibly because the constraints do not exist or are named differently: %', SQLERRM;
END $$;
