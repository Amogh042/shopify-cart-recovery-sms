-- ==========================================
-- ADD sms_sent_at COLUMN
-- The SMS scheduler writes to this column (sms-scheduler.js line 44)
-- but no migration ever created it.
-- Run this in the Supabase SQL Editor.
-- ==========================================

ALTER TABLE abandoned_carts
ADD COLUMN sms_sent_at TIMESTAMP WITH TIME ZONE NULL;
