-- ============================================
-- RLS Policies for server-side access via Supabase anon/service key
-- Run this in the Supabase SQL Editor
-- ============================================

-- Allow the anon key (used by our server) to perform all operations
-- on the three tables. In production, use a service_role key instead.

-- Shops table
create policy "Allow all operations on shops"
  on shops for all
  using (true)
  with check (true);

-- Abandoned Carts table
create policy "Allow all operations on abandoned_carts"
  on abandoned_carts for all
  using (true)
  with check (true);

-- SMS Logs table
create policy "Allow all operations on sms_logs"
  on sms_logs for all
  using (true)
  with check (true);
