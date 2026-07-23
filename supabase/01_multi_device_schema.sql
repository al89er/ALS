-- Migration: Multi-Device / Multi-User Schema Expansion
-- Description: Adds device_id to all tables for isolation across multiple desktop agents and users.

-- 1. device_status table
ALTER TABLE IF EXISTS public.device_status 
  ADD COLUMN IF NOT EXISTS device_id TEXT DEFAULT 'home_desktop_agent',
  ADD COLUMN IF NOT EXISTS device_name TEXT DEFAULT 'Home Desktop Agent',
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

-- 2. commands table
ALTER TABLE IF EXISTS public.commands 
  ADD COLUMN IF NOT EXISTS device_id TEXT DEFAULT 'home_desktop_agent',
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_commands_device_id_status ON public.commands(device_id, status);

-- 3. logs table
ALTER TABLE IF EXISTS public.logs 
  ADD COLUMN IF NOT EXISTS device_id TEXT DEFAULT 'home_desktop_agent',
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_logs_device_id_created ON public.logs(device_id, created_at DESC);

-- 4. todays_proof table
ALTER TABLE IF EXISTS public.todays_proof 
  ADD COLUMN IF NOT EXISTS device_id TEXT DEFAULT 'home_desktop_agent',
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

-- 5. daily_schedules table
ALTER TABLE IF EXISTS public.daily_schedules 
  ADD COLUMN IF NOT EXISTS device_id TEXT DEFAULT 'home_desktop_agent',
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

-- 6. skip_days table
ALTER TABLE IF EXISTS public.skip_days 
  ADD COLUMN IF NOT EXISTS device_id TEXT DEFAULT 'home_desktop_agent',
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_skip_days_device_id ON public.skip_days(device_id, date);

-- Helper function / view for active devices list (optional)
CREATE OR REPLACE VIEW public.user_devices AS
SELECT 
  id,
  COALESCE(device_id, id) AS device_id,
  COALESCE(device_name, id) AS device_name,
  last_seen,
  current_status,
  user_id
FROM public.device_status;
