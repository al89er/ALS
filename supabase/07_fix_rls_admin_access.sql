-- Migration: Fix RLS for Admin Access
-- Description: Allows Admin (muhammadafif@upm.edu.my) to read and manage all todays_proof, daily_schedules, and skip_days, just like commands and logs.

-- 1. todays_proof
DROP POLICY IF EXISTS "Users can manage their own todays_proof" ON public.todays_proof;
CREATE POLICY "Users can manage their own todays_proof" ON public.todays_proof 
FOR ALL USING (
  auth.uid() = user_id 
  OR 
  device_id IN (SELECT device_id FROM public.device_status WHERE user_id = auth.uid())
  OR
  auth.email() = 'muhammadafif@upm.edu.my'
) WITH CHECK (
  auth.uid() = user_id 
  OR 
  device_id IN (SELECT device_id FROM public.device_status WHERE user_id = auth.uid())
  OR
  auth.email() = 'muhammadafif@upm.edu.my'
);

-- 2. daily_schedules
DROP POLICY IF EXISTS "Users can manage their own daily_schedules" ON public.daily_schedules;
CREATE POLICY "Users can manage their own daily_schedules" ON public.daily_schedules 
FOR ALL USING (
  auth.uid() = user_id 
  OR 
  device_id IN (SELECT device_id FROM public.device_status WHERE user_id = auth.uid())
  OR
  auth.email() = 'muhammadafif@upm.edu.my'
) WITH CHECK (
  auth.uid() = user_id 
  OR 
  device_id IN (SELECT device_id FROM public.device_status WHERE user_id = auth.uid())
  OR
  auth.email() = 'muhammadafif@upm.edu.my'
);

-- 3. skip_days
DROP POLICY IF EXISTS "Users can manage their own skip_days" ON public.skip_days;
CREATE POLICY "Users can manage their own skip_days" ON public.skip_days 
FOR ALL USING (
  auth.uid() = user_id 
  OR 
  device_id IN (SELECT device_id FROM public.device_status WHERE user_id = auth.uid())
  OR
  auth.email() = 'muhammadafif@upm.edu.my'
) WITH CHECK (
  auth.uid() = user_id 
  OR 
  device_id IN (SELECT device_id FROM public.device_status WHERE user_id = auth.uid())
  OR
  auth.email() = 'muhammadafif@upm.edu.my'
);

-- 4. device_status
DROP POLICY IF EXISTS "Users can manage their own device_status" ON public.device_status;
CREATE POLICY "Users can manage their own device_status" ON public.device_status 
FOR ALL USING (
  auth.uid() = user_id 
  OR
  auth.email() = 'muhammadafif@upm.edu.my'
) WITH CHECK (
  auth.uid() = user_id 
  OR
  auth.email() = 'muhammadafif@upm.edu.my'
);

-- 5. commands
DROP POLICY IF EXISTS "Users can manage their own commands" ON public.commands;
CREATE POLICY "Users can manage their own commands" ON public.commands 
FOR ALL USING (
  auth.uid() = user_id 
  OR 
  device_id IN (SELECT device_id FROM public.device_status WHERE user_id = auth.uid())
  OR
  auth.email() = 'muhammadafif@upm.edu.my'
) WITH CHECK (
  auth.uid() = user_id 
  OR 
  device_id IN (SELECT device_id FROM public.device_status WHERE user_id = auth.uid())
  OR
  auth.email() = 'muhammadafif@upm.edu.my'
);

-- 6. logs
DROP POLICY IF EXISTS "Users can manage their own logs" ON public.logs;
CREATE POLICY "Users can manage their own logs" ON public.logs 
FOR ALL USING (
  auth.uid() = user_id 
  OR 
  device_id IN (SELECT device_id FROM public.device_status WHERE user_id = auth.uid())
  OR
  auth.email() = 'muhammadafif@upm.edu.my'
) WITH CHECK (
  auth.uid() = user_id 
  OR 
  device_id IN (SELECT device_id FROM public.device_status WHERE user_id = auth.uid())
  OR
  auth.email() = 'muhammadafif@upm.edu.my'
);
