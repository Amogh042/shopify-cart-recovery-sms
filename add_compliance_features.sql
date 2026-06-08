-- ==========================================
-- COMPLIANCE FEATURES MIGRATION
-- 1. SMS opt-out table
-- 2. is_active column on shops
-- Run this in the Supabase SQL Editor.
-- ==========================================

-- 1. SMS opt-out table
CREATE TABLE IF NOT EXISTS sms_optouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number TEXT NOT NULL UNIQUE,
  opted_out_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sms_optouts_phone ON sms_optouts(phone_number);

ALTER TABLE sms_optouts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all operations on sms_optouts"
  ON sms_optouts FOR ALL
  USING (true)
  WITH CHECK (true);

-- 2. is_active column on shops (for app uninstall tracking)
ALTER TABLE shops
ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
