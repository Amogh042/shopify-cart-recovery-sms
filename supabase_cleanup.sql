-- ==========================================
-- SUPABASE CLEANUP SCRIPT
-- Deletes all test and fake data from tables
-- ==========================================

-- 1. Delete test abandoned carts
-- Removes carts with test phone numbers, test shop domains, test names, or test tokens
DELETE FROM abandoned_carts WHERE
  customer_phone = '+15551234567' OR
  shop_domain = 'mytest.myshopify.com' OR
  customer_name = 'Jane Doe' OR
  cart_token LIKE '%test%';

-- 2. Delete test SMS logs
-- Removes SMS logs for test phone number
DELETE FROM sms_logs WHERE phone_number = '+15551234567';

-- 3. Verify cleanup - Check remaining abandoned carts
SELECT 
  id,
  shop_domain,
  customer_phone,
  customer_name,
  cart_token,
  abandoned_at,
  created_at
FROM abandoned_carts 
ORDER BY created_at DESC;

-- 4. Verify cleanup - Check remaining SMS logs
SELECT 
  id,
  phone_number,
  status,
  message_sent,
  created_at
FROM sms_logs 
ORDER BY created_at DESC;

-- ==========================================
-- ADDITIONAL USEFUL QUERIES
-- ==========================================

-- Count remaining records
SELECT 'abandoned_carts' as table_name, COUNT(*) as record_count FROM abandoned_carts
UNION ALL
SELECT 'sms_logs' as table_name, COUNT(*) as record_count FROM sms_logs;

-- Check for any remaining test data (optional verification)
SELECT 'Test data still exists in abandoned_carts' as warning
FROM abandoned_carts 
WHERE 
  customer_phone = '+15551234567' OR
  shop_domain = 'mytest.myshopify.com' OR
  customer_name = 'Jane Doe' OR
  cart_token LIKE '%test%'
LIMIT 1;
