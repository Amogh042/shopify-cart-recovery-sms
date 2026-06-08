-- ============================================
-- RLS Policies — shop-scoped access
-- Run this in the Supabase SQL Editor.
--
-- These policies use a Postgres function that reads the
-- current shop_domain from a session variable set by the
-- application before each request.  Because our Express
-- server uses the Supabase service_role key (which bypasses
-- RLS), these policies act as a defence-in-depth layer:
-- they lock down direct client access via the anon key so
-- that one shop can never read/write another shop's data.
--
-- IMPORTANT: Drop the old wide-open policies first.
-- ============================================

-- 0. Helper: returns the shop_domain stored in the current
--    session setting (set via: SET LOCAL app.current_shop_domain = '…').
--    Falls back to empty string so queries simply return no rows
--    when the setting is missing.
CREATE OR REPLACE FUNCTION current_shop_domain()
RETURNS text
LANGUAGE sql STABLE
AS $$
  SELECT coalesce(current_setting('app.current_shop_domain', true), '');
$$;

-- ============================================
-- Drop old wide-open policies
-- ============================================
DROP POLICY IF EXISTS "Allow all operations on shops" ON shops;
DROP POLICY IF EXISTS "Allow all operations on abandoned_carts" ON abandoned_carts;
DROP POLICY IF EXISTS "Allow all operations on sms_logs" ON sms_logs;
DROP POLICY IF EXISTS "Allow all operations on sms_optouts" ON sms_optouts;

-- ============================================
-- Shops table — each shop can only see its own row
-- ============================================
CREATE POLICY "Shop can read own row"
  ON shops FOR SELECT
  USING (shop_domain = current_shop_domain());

CREATE POLICY "Shop can update own row"
  ON shops FOR UPDATE
  USING (shop_domain = current_shop_domain())
  WITH CHECK (shop_domain = current_shop_domain());

CREATE POLICY "Server can insert shops"
  ON shops FOR INSERT
  WITH CHECK (true);

-- ============================================
-- Abandoned Carts — scoped to shop_domain
-- ============================================
CREATE POLICY "Shop can read own carts"
  ON abandoned_carts FOR SELECT
  USING (shop_domain = current_shop_domain());

CREATE POLICY "Shop can insert own carts"
  ON abandoned_carts FOR INSERT
  WITH CHECK (shop_domain = current_shop_domain());

CREATE POLICY "Shop can update own carts"
  ON abandoned_carts FOR UPDATE
  USING (shop_domain = current_shop_domain())
  WITH CHECK (shop_domain = current_shop_domain());

CREATE POLICY "Shop can delete own carts"
  ON abandoned_carts FOR DELETE
  USING (shop_domain = current_shop_domain());

-- ============================================
-- SMS Logs — scoped via cart_id → abandoned_carts.shop_domain
-- ============================================
CREATE POLICY "Shop can read own sms_logs"
  ON sms_logs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM abandoned_carts ac
      WHERE ac.id = sms_logs.cart_id
        AND ac.shop_domain = current_shop_domain()
    )
  );

CREATE POLICY "Shop can insert own sms_logs"
  ON sms_logs FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM abandoned_carts ac
      WHERE ac.id = sms_logs.cart_id
        AND ac.shop_domain = current_shop_domain()
    )
  );

CREATE POLICY "Shop can delete own sms_logs"
  ON sms_logs FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM abandoned_carts ac
      WHERE ac.id = sms_logs.cart_id
        AND ac.shop_domain = current_shop_domain()
    )
  );

-- ============================================
-- SMS Optouts — server-managed, allow all for now
-- (phone numbers are not shop-scoped)
-- ============================================
CREATE POLICY "Server can manage optouts"
  ON sms_optouts FOR ALL
  USING (true)
  WITH CHECK (true);
