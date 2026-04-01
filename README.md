# Shopify Cart Recovery SMS

Recover abandoned Shopify checkouts using automated SMS follow‑ups powered by Supabase + Twilio.

## What this app does

- Receives Shopify cart update webhooks and stores potential abandoned carts in Supabase.
- Runs an SMS scheduler every 5 minutes to message customers who abandoned checkout more than 1 hour ago.
- Marks carts as `sms_sent=true` after a successful send and logs each attempt to `sms_logs`.
- Serves a clean dashboard at `GET /dashboard` showing stats and the last 30 abandoned carts for the active shop.

## Tech stack

- **Node.js**: runtime
- **Express**: server + routes + webhook handling
- **Shopify API** (`@shopify/shopify-api`): OAuth + webhook verification
- **Supabase** (`@supabase/supabase-js`): database + queries
- **Twilio** (`twilio`): SMS delivery
- **node-cron**: scheduler (every 5 minutes)

## How it works (high-level flow)

```
Shopify Store
  |
  | 1) Cart updated / checkout started (webhook)
  v
Express webhook route (/webhooks/carts/update)
  |
  | - Verify Shopify HMAC
  | - Extract customer phone + cart items + checkout URL
  | - Insert row into Supabase abandoned_carts
  v
Supabase (abandoned_carts)
  |
  | 2) Cron job runs every 5 minutes
  v
SMS Scheduler (node-cron)
  |
  | - Query carts where sms_sent=false AND abandoned_at < now - 1 hour
  | - Send Twilio SMS to customer_phone
  | - Update abandoned_carts.sms_sent = true (success only)
  | - Insert row into Supabase sms_logs (always)
  v
Customer receives SMS -> returns to checkout_url
```

## Local setup

### Prerequisites

- Node.js (recommended: latest LTS)
- A Shopify Partner account + development store
- A Supabase project (Postgres)
- A Twilio account (trial is fine for testing)

### Install

```bash
npm install
```

### Configure environment variables

Copy the template and fill values:

```bash
copy .env.template .env
```

Required variables:

#### Shopify

- **SHOPIFY_API_KEY**: Shopify app API key
- **SHOPIFY_API_SECRET**: Shopify app API secret
- **SHOPIFY_SCOPES**: comma-separated scopes (example: `read_checkouts,write_checkouts,...`)
- **HOST**: your app base URL (local example: `http://localhost:3000`)

#### Supabase

- **SUPABASE_URL**: Supabase project URL
- **SUPABASE_KEY**: Supabase anon/service key (use a key that matches your RLS policies)

#### Twilio

- **TWILIO_ACCOUNT_SID**
- **TWILIO_AUTH_TOKEN**
- **TWILIO_PHONE_NUMBER**: E.164 format (example: `+1260...`)

#### Session

- **SESSION_SECRET**: random string for cookie sessions (recommended)

### Run

```bash
npm start
```

Open:

- **Dashboard**: `http://localhost:3000/dashboard?shop=<yourstore.myshopify.com>`
- **OAuth begin**: `http://localhost:3000/auth?shop=<yourstore.myshopify.com>`

## Database tables (expected)

This repo assumes you have (at least) the following tables in Supabase:

- `shops` (stores `shop_domain`, `access_token`, ...)
- `abandoned_carts` (stores cart details + `sms_sent`, `recovered`, timestamps)
- `sms_logs` (stores send attempts: `cart_id`, `phone_number`, `message_sent`, `sent_at`, `status`)

If your DB schema differs, update the Supabase queries accordingly.

## Notes

- Twilio trial accounts may prepend messages with: “Sent from your Twilio trial account - …”.
- Phone numbers must be valid E.164 (e.g. `+919980170123`). Invalid numbers will log failed attempts.

## Useful scripts (optional)

These scripts exist to help test locally:

- `node trigger-sms-once.js` — run the SMS job immediately
- `node supabase-latest-cart.js <shop_domain>` — print latest cart for a shop
- `node supabase-backdate-cart.js <cart_id> [hoursAgo]` — backdate `abandoned_at`
- `node twilio-last-sms.js <toPhoneE164>` — show recent Twilio messages to a phone
- `node screenshot-dashboard.js` — generate `dashboard-screenshot.png`

