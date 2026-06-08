-- ==========================================
-- ADD discount_code_created COLUMN TO shops TABLE
-- Tracks whether the COMEBACK10 discount code was
-- auto-created in the Shopify store during OAuth.
-- Run this in the Supabase SQL Editor.
-- ==========================================

ALTER TABLE shops
ADD COLUMN IF NOT EXISTS discount_code_created BOOLEAN DEFAULT false;
