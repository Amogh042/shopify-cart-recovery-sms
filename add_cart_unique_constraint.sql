-- ==========================================
-- ADD UNIQUE CONSTRAINT ON (shop_domain, cart_token)
-- Prevents duplicate cart rows from repeated carts/update webhooks.
-- Required for the .upsert({ onConflict: 'shop_domain,cart_token' }) call.
-- Run this in the Supabase SQL Editor.
-- ==========================================

ALTER TABLE abandoned_carts
ADD CONSTRAINT abandoned_carts_shop_domain_cart_token_key
UNIQUE (shop_domain, cart_token);
