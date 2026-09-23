-- Migration: Add Missing Columns
-- Description: Adds 'updated_at' column to commands table which is expected by hub-client.js

ALTER TABLE IF EXISTS public.commands
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE;
