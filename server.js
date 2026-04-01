require('dotenv').config();
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const shopify = require('./shopify');
const supabase = require('./supabase');
const { startScheduler } = require('./sms-scheduler');

const app = express();
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
app.use(
  session({
    name: 'shopify_plugin_sid',
    secret: process.env.SESSION_SECRET || 'dev-session-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);

// ─── Raw body capture for webhook HMAC verification ───
// Webhook routes need the raw body to verify the HMAC signature.
// We capture it BEFORE express.json() parses the body.
app.use('/webhooks', express.raw({ type: 'application/json' }));
app.use((req, res, next) => {
  if (!req.path.startsWith('/webhooks')) {
    express.json()(req, res, next);
  } else {
    next();
  }
});

// ─── HMAC Verification Middleware ───
function verifyShopifyWebhook(req, res, next) {
  const hmacHeader = req.get('X-Shopify-Hmac-Sha256');

  if (!hmacHeader) {
    console.warn('⚠️  Webhook received without HMAC header');
    return res.status(401).json({ error: 'Missing HMAC signature' });
  }

  const body = req.body; // Buffer from express.raw()
  const generatedHash = crypto
    .createHmac('sha256', process.env.SHOPIFY_API_SECRET)
    .update(body)
    .digest('base64');

  if (generatedHash !== hmacHeader) {
    console.warn('⚠️  Webhook HMAC mismatch — rejecting');
    return res.status(401).json({ error: 'HMAC verification failed' });
  }

  // Parse the raw buffer into JSON for downstream handlers
  req.body = JSON.parse(body.toString('utf8'));
  console.log('✅ Webhook HMAC verified');
  next();
}

// ─── Health check ───
app.get('/', (req, res) => {
  // When launched from Shopify Admin, the app is opened with ?shop=... (and sometimes &host=...).
  // Redirecting to /dashboard gives a friendly UI instead of raw JSON.
  if (req.query.shop) {
    return res.redirect(`/dashboard?shop=${encodeURIComponent(String(req.query.shop))}`);
  }

  res
    .status(200)
    .type('html')
    .send(
      `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CartRecovery SMS</title>
    <style>
      body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#fff;color:#0f172a;margin:0}
      .header{background:#0b5cff;color:#fff;padding:18px 22px}
      .wrap{max-width:1100px;margin:0 auto;padding:22px}
      a{color:#0b5cff}
      .card{border:1px solid #e2e8f0;border-radius:14px;padding:14px 16px;background:#fff}
      code{background:#eef2ff;padding:2px 6px;border-radius:6px}
    </style>
  </head>
  <body>
    <div class="header">
      <div style="max-width:1100px;margin:0 auto">
        <div style="font-weight:900;font-size:18px">CartRecovery SMS</div>
      </div>
    </div>
    <div class="wrap">
      <div class="card">
        <div style="font-weight:800;margin-bottom:6px">Server is running</div>
        <div>Open <code>/dashboard?shop=&lt;yourstore.myshopify.com&gt;</code> or start OAuth at <code>/auth?shop=&lt;yourstore.myshopify.com&gt;</code>.</div>
      </div>
    </div>
  </body>
</html>`
    );
});

// ─── OAuth: Begin ───
app.get('/auth', async (req, res) => {
  const shop = req.query.shop;

  if (!shop) {
    return res.status(400).json({ error: 'Missing ?shop= query parameter' });
  }

  try {
    await shopify.auth.begin({
      shop: shopify.utils.sanitizeShop(shop, true),
      callbackPath: '/auth/callback',
      isOnline: false,
      rawRequest: req,
      rawResponse: res,
    });
  } catch (error) {
    console.error('Auth begin error:', error.message);
    res.status(500).json({ error: 'Failed to start OAuth', details: error.message });
  }
});

// ─── OAuth: Callback ───
app.get('/auth/callback', async (req, res) => {
  try {
    const callback = await shopify.auth.callback({
      rawRequest: req,
      rawResponse: res,
    });

    const { shop, accessToken } = callback.session;
    console.log(`✅ OAuth complete for ${shop}`);
    console.log(`   Access token: ${accessToken.substring(0, 8)}...`);

    // Persist the shop domain in the user's session for the dashboard.
    req.session.shop_domain = shop;

    const { data, error } = await supabase
      .from('shops')
      .upsert(
        { shop_domain: shop, access_token: accessToken },
        { onConflict: 'shop_domain' }
      )
      .select();

    if (error) {
      console.error('Supabase save error:', error);
      return res.status(500).json({ error: 'Failed to save shop', details: error.message });
    }

    console.log(`   Saved to Supabase:`, data);
    res.redirect('/dashboard');
  } catch (error) {
    console.error('Auth callback error:', error.message);
    res.status(500).json({ error: 'OAuth callback failed', details: error.message });
  }
});

// ─── Webhook: Cart Update (Abandoned Cart Detection) ───
app.post('/webhooks/carts/update', verifyShopifyWebhook, async (req, res) => {
  try {
    const cart = req.body;
    const shopDomain = req.get('X-Shopify-Shop-Domain') || 'unknown';

    console.log(`📦 Cart update webhook from ${shopDomain}`);
    console.log(`   Cart token: ${cart.token}`);
    console.log(`   Line items: ${cart.line_items?.length || 0}`);

    // Extract customer info
    const customerPhone = cart.phone || cart.customer?.phone || null;
    const customerEmail = cart.email || cart.customer?.email || null;
    const customerName =
      cart.customer?.first_name && cart.customer?.last_name
        ? `${cart.customer.first_name} ${cart.customer.last_name}`
        : cart.customer?.first_name || cart.billing_address?.name || null;

    // Only save if we have a phone number or email (we need a way to contact them)
    if (!customerPhone && !customerEmail) {
      console.log('   ⏭️  Skipping — no customer phone or email');
      return res.status(200).json({ status: 'skipped', reason: 'no contact info' });
    }

    // Build product names (comma-separated)
    const productNames = (cart.line_items || [])
      .map((item) => item.title || item.product_title || 'Unknown Product')
      .join(', ');

    // Calculate cart total
    const cartTotal = parseFloat(cart.total_price || '0');

    // Build checkout URL
    const checkoutUrl = cart.checkout_url ||
      `https://${shopDomain}/checkouts/${cart.token}` || null;

    // Check if this cart_token already exists (avoid duplicates)
    const { data: existing } = await supabase
      .from('abandoned_carts')
      .select('id')
      .eq('cart_token', cart.token)
      .maybeSingle();

    if (existing) {
      console.log('   ⏭️  Cart already tracked, skipping duplicate');
      return res.status(200).json({ status: 'skipped', reason: 'already tracked' });
    }

    // Insert the abandoned cart
    const { data, error } = await supabase
      .from('abandoned_carts')
      .insert({
        shop_domain: shopDomain,
        cart_token: cart.token,
        customer_name: customerName,
        customer_phone: customerPhone,
        cart_total: cartTotal,
        product_names: productNames,
        checkout_url: checkoutUrl,
        abandoned_at: new Date().toISOString(),
      })
      .select();

    if (error) {
      console.error('   ❌ Supabase insert error:', error.message);
      return res.status(500).json({ error: 'Failed to save cart', details: error.message });
    }

    console.log('   ✅ Abandoned cart saved:', data[0]?.id);
    res.status(200).json({ status: 'ok', cart_id: data[0]?.id });
  } catch (error) {
    console.error('Webhook handler error:', error.message);
    res.status(500).json({ error: 'Webhook processing failed', details: error.message });
  }
});

// ─── Dashboard placeholder ───
function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatMoney(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '$0.00';
  return `$${num.toFixed(2)}`;
}

function formatDateTime(value) {
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleString();
}

app.get('/dashboard', async (req, res) => {
  try {
    // Convenience for local testing: /dashboard?shop=yourstore.myshopify.com
    // Stores shop_domain in session then redirects to /dashboard (session-backed).
    if (req.query.shop) {
      req.session.shop_domain = String(req.query.shop);
      return res.redirect('/dashboard');
    }

    const shopDomain = req.session.shop_domain;
    if (!shopDomain) {
      return res
        .status(401)
        .type('html')
        .send(
          `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CartRecovery SMS</title>
    <style>
      body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#fff;color:#0f172a;margin:0}
      .header{background:#0b5cff;color:#fff;padding:18px 22px}
      .wrap{max-width:1100px;margin:0 auto;padding:22px}
      a{color:#0b5cff}
      .note{background:#f1f5ff;border:1px solid #dbe6ff;border-radius:12px;padding:14px 16px}
      code{background:#eef2ff;padding:2px 6px;border-radius:6px}
    </style>
  </head>
  <body>
    <div class="header">
      <div style="max-width:1100px;margin:0 auto">
        <div style="font-weight:800;font-size:18px">CartRecovery SMS</div>
      </div>
    </div>
    <div class="wrap">
      <div class="note">
        <div style="font-weight:700;margin-bottom:6px">No shop in session</div>
        <div>To view the dashboard locally, open <code>/dashboard?shop=yourstore.myshopify.com</code> once to set the session.</div>
      </div>
    </div>
  </body>
</html>`
        );
    }

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).toISOString();

    const { count: cartsThisMonthCount, error: cartsThisMonthErr } = await supabase
      .from('abandoned_carts')
      .select('id', { count: 'exact', head: true })
      .eq('shop_domain', shopDomain)
      .gte('abandoned_at', monthStart);

    if (cartsThisMonthErr) {
      console.error('Dashboard query error (cartsThisMonth):', cartsThisMonthErr.message);
    }

    const { count: smsSentCount, error: smsSentErr } = await supabase
      .from('abandoned_carts')
      .select('id', { count: 'exact', head: true })
      .eq('shop_domain', shopDomain)
      .eq('sms_sent', true);

    if (smsSentErr) {
      console.error('Dashboard query error (smsSentCount):', smsSentErr.message);
    }

    const { data: recoveredRows, error: recoveredErr } = await supabase
      .from('abandoned_carts')
      .select('cart_total')
      .eq('shop_domain', shopDomain)
      .eq('recovered', true);

    if (recoveredErr) {
      console.error('Dashboard query error (recoveredRevenue):', recoveredErr.message);
    }

    const recoveredRevenue = (recoveredRows || []).reduce((sum, row) => sum + (Number(row.cart_total) || 0), 0);

    const { data: recentCarts, error: recentErr } = await supabase
      .from('abandoned_carts')
      .select('id, customer_name, product_names, cart_total, sms_sent, recovered, abandoned_at')
      .eq('shop_domain', shopDomain)
      .order('abandoned_at', { ascending: false })
      .limit(30);

    if (recentErr) {
      console.error('Dashboard query error (recentCarts):', recentErr.message);
    }

    const cards = [
      {
        label: 'Total carts abandoned this month',
        value: Number.isFinite(cartsThisMonthCount) ? String(cartsThisMonthCount) : '—',
      },
      {
        label: 'Total SMS messages sent',
        value: Number.isFinite(smsSentCount) ? String(smsSentCount) : '—',
      },
      {
        label: 'Total revenue recovered',
        value: formatMoney(recoveredRevenue),
      },
    ];

    const rowsHtml = (recentCarts || [])
      .map((cart) => {
        const smsSent = cart.sms_sent ? 'Yes' : 'No';
        const recovered = cart.recovered ? 'Yes' : 'No';
        return `<tr>
          <td>${escapeHtml(cart.customer_name || '')}</td>
          <td>${escapeHtml(cart.product_names || '')}</td>
          <td style="text-align:right">${escapeHtml(formatMoney(cart.cart_total))}</td>
          <td>${escapeHtml(smsSent)}</td>
          <td>${escapeHtml(recovered)}</td>
          <td>${escapeHtml(formatDateTime(cart.abandoned_at))}</td>
        </tr>`;
      })
      .join('\n');

    res
      .status(200)
      .type('html')
      .send(
        `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CartRecovery SMS — ${escapeHtml(shopDomain)}</title>
    <style>
      :root{
        --blue:#0b5cff;
        --text:#0f172a;
        --muted:#475569;
        --line:#e2e8f0;
        --row:#f8fafc;
      }
      body{
        font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;
        margin:0;
        background:#fff;
        color:var(--text);
      }
      .header{
        background:var(--blue);
        color:#fff;
        padding:18px 22px;
      }
      .header-inner{
        max-width:1100px;
        margin:0 auto;
        display:flex;
        align-items:baseline;
        justify-content:space-between;
        gap:16px;
      }
      .brand{
        font-weight:900;
        letter-spacing:.2px;
        font-size:18px;
      }
      .shop{
        font-weight:700;
        opacity:.95;
        font-size:14px;
      }
      .wrap{max-width:1100px;margin:0 auto;padding:22px}
      .cards{
        display:grid;
        grid-template-columns:repeat(3, minmax(0, 1fr));
        gap:14px;
        margin-bottom:18px;
      }
      .card{
        border:1px solid var(--line);
        border-radius:14px;
        padding:14px 16px;
        background:#fff;
      }
      .card .label{
        color:var(--muted);
        font-weight:700;
        font-size:12px;
        text-transform:uppercase;
        letter-spacing:.06em;
      }
      .card .value{
        margin-top:8px;
        font-weight:900;
        font-size:26px;
      }
      .section-title{
        display:flex;
        align-items:center;
        justify-content:space-between;
        margin:6px 0 10px;
      }
      .section-title h2{
        font-size:16px;
        margin:0;
        font-weight:900;
      }
      .hint{color:var(--muted);font-size:12px}
      table{
        width:100%;
        border-collapse:separate;
        border-spacing:0;
        border:1px solid var(--line);
        border-radius:14px;
        overflow:hidden;
      }
      thead th{
        text-align:left;
        font-size:12px;
        color:var(--muted);
        background:#f1f5ff;
        border-bottom:1px solid var(--line);
        padding:10px 12px;
        font-weight:900;
        letter-spacing:.04em;
        text-transform:uppercase;
      }
      tbody td{
        padding:10px 12px;
        border-bottom:1px solid var(--line);
        vertical-align:top;
      }
      tbody tr:nth-child(even){background:var(--row)}
      tbody tr:last-child td{border-bottom:none}
      @media (max-width: 900px){
        .cards{grid-template-columns:1fr}
        .header-inner{flex-direction:column;align-items:flex-start}
      }
    </style>
  </head>
  <body>
    <div class="header">
      <div class="header-inner">
        <div class="brand">CartRecovery SMS</div>
        <div class="shop">${escapeHtml(shopDomain)}</div>
      </div>
    </div>

    <div class="wrap">
      <div class="cards">
        ${cards
          .map(
            (c) => `<div class="card">
          <div class="label">${escapeHtml(c.label)}</div>
          <div class="value">${escapeHtml(c.value)}</div>
        </div>`
          )
          .join('\n')}
      </div>

      <div class="section-title">
        <h2>Last 30 abandoned carts</h2>
        <div class="hint">Newest first</div>
      </div>

      <table>
        <thead>
          <tr>
            <th>Customer Name</th>
            <th>Product</th>
            <th style="text-align:right">Cart Value</th>
            <th>SMS Sent</th>
            <th>Recovered</th>
            <th>Date</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml || ''}
        </tbody>
      </table>
    </div>
  </body>
</html>`
      );
  } catch (error) {
    console.error('Dashboard error:', error.message);
    res.status(500).json({ error: 'Dashboard failed', details: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Auth URL: http://localhost:${PORT}/auth?shop=yourstore.myshopify.com`);

  // Start the SMS recovery scheduler
  startScheduler();
});
