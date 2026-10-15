-- Migration: Add Proof Thumbnail Column to todays_proof
-- Description: Stores visual attendance proof snapshots as base64 thumbnails for verification in Web App and Desktop Engine.

ALTER TABLE IF EXISTS public.todays_proof
  ADD COLUMN IF NOT EXISTS proof_thumbnail TEXT;
