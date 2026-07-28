-- Migration: Enable Row Level Security (RLS)
-- Description: Assigns legacy data to muhammadafif@upm.edu.my and enforces RLS on all tables.

DO $$
DECLARE
    target_uid UUID;
BEGIN
    -- Get the UID for muhammadafif@upm.edu.my
    SELECT id INTO target_uid FROM auth.users WHERE email = 'muhammadafif@upm.edu.my';
    
    IF target_uid IS NOT NULL THEN
        -- Map existing legacy records (which were created by service_role) to the user's UUID
        UPDATE public.device_status SET user_id = target_uid WHERE user_id IS NULL;
        UPDATE public.commands SET user_id = target_uid WHERE user_id IS NULL;
        UPDATE public.logs SET user_id = target_uid WHERE user_id IS NULL;
        UPDATE public.todays_proof SET user_id = target_uid WHERE user_id IS NULL;
        UPDATE public.daily_schedules SET user_id = target_uid WHERE user_id IS NULL;
        UPDATE public.skip_days SET user_id = target_uid WHERE user_id IS NULL;
    END IF;
END $$;

-- 1. Set default user_id to auth.uid() on all tables so future inserts are automatically tagged
ALTER TABLE public.device_status ALTER COLUMN user_id SET DEFAULT auth.uid();
ALTER TABLE public.commands ALTER COLUMN user_id SET DEFAULT auth.uid();
ALTER TABLE public.logs ALTER COLUMN user_id SET DEFAULT auth.uid();
ALTER TABLE public.todays_proof ALTER COLUMN user_id SET DEFAULT auth.uid();
ALTER TABLE public.daily_schedules ALTER COLUMN user_id SET DEFAULT auth.uid();
ALTER TABLE public.skip_days ALTER COLUMN user_id SET DEFAULT auth.uid();

-- 2. Enable Row Level Security
ALTER TABLE public.device_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.todays_proof ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skip_days ENABLE ROW LEVEL SECURITY;

-- 3. Create RLS Policies (Users can only access rows where user_id matches their own auth.uid)
CREATE POLICY "Users can manage their own device_status" ON public.device_status FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can manage their own commands" ON public.commands FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can manage their own logs" ON public.logs FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can manage their own todays_proof" ON public.todays_proof FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can manage their own daily_schedules" ON public.daily_schedules FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can manage their own skip_days" ON public.skip_days FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- 4. Update the User Devices View to be secure (Views bypass RLS by default unless security_invoker = true is used)
DROP VIEW IF EXISTS public.user_devices;
CREATE VIEW public.user_devices WITH (security_invoker = true) AS
SELECT 
  id,
  COALESCE(device_id, id) AS device_id,
  COALESCE(device_name, id) AS device_name,
  last_seen,
  current_status,
  user_id
FROM public.device_status;
