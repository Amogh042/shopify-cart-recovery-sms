-- ============================================
-- Shopify Abandoned Cart Recovery - Database Schema
-- Run this in the Supabase SQL Editor
-- ============================================

-- 1. Shops table
-- Stores Shopify store credentials and billing status
create table if not exists shops (
  id uuid primary key default gen_random_uuid(),
  shop_domain text not null unique,
  access_token text not null,
  is_paid boolean default false,
  created_at timestamp with time zone default now()
);

-- 2. Abandoned Carts table
-- Tracks abandoned carts and recovery status
create table if not exists abandoned_carts (
  id uuid primary key default gen_random_uuid(),
  shop_domain text not null references shops(shop_domain) on delete cascade,
  cart_token text not null,
  customer_name text,
  customer_phone text,
  cart_total numeric not null default 0,
  product_names text,
  checkout_url text,
  abandoned_at timestamp with time zone default now(),
  sms_sent boolean default false,
  recovered boolean default false,
  created_at timestamp with time zone default now()
);

-- 3. SMS Logs table
-- Records every SMS sent for audit and tracking
create table if not exists sms_logs (
  id uuid primary key default gen_random_uuid(),
  cart_id uuid not null references abandoned_carts(id) on delete cascade,
  phone_number text not null,
  message_sent text not null,
  sent_at timestamp with time zone default now(),
  status text not null default 'pending'
);

-- ============================================
-- Indexes for common query patterns
-- ============================================
create index if not exists idx_abandoned_carts_shop_domain on abandoned_carts(shop_domain);
create index if not exists idx_abandoned_carts_sms_sent on abandoned_carts(sms_sent);
create index if not exists idx_abandoned_carts_recovered on abandoned_carts(recovered);
create index if not exists idx_sms_logs_cart_id on sms_logs(cart_id);

-- ============================================
-- Row Level Security (recommended for Supabase)
-- ============================================
alter table shops enable row level security;
alter table abandoned_carts enable row level security;
alter table sms_logs enable row level security;
