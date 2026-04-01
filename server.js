require('dotenv').config();
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const shopify = require('./shopify');
const supabase = require('./supabase');
const { startScheduler } = require('./sms-scheduler');

const app = express();
const PORT = process.env.PORT || 3000;

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

// ─── Raw body for webhooks ───
app.use('/webhooks', express.raw({ type: 'application/json' }));
app.use((req, res, next) => {
  if (!req.path.startsWith('/webhooks')) {
    express.json()(req, res, next);
  } else {
    next();
  }
});

// ─── HMAC Verification ───
function verifyShopifyWebhook(req, res, next) {
  const hmacHeader = req.get('X-Shopify-Hmac-Sha256');

  if (!hmacHeader) return res.status(401).json({ error: 'Missing HMAC' });

  const generatedHash = crypto
    .createHmac('sha256', process.env.SHOPIFY_API_SECRET)
    .update(req.body)
    .digest('base64');

  if (generatedHash !== hmacHeader) {
    return res.status(401).json({ error: 'Invalid HMAC' });
  }

  req.body = JSON.parse(req.body.toString('utf8'));
  next();
}

// ─── Root route ───
app.get('/', (req, res) => {
  const shop = req.query.shop;

  if (shop) {
    return res.redirect(`/auth?shop=${encodeURIComponent(shop)}`);
  }

  return res.send('No shop provided');
});

// ─── Auth ───
app.get('/auth', async (req, res) => {
  const shop = req.query.shop;

  if (!shop) {
    return res.status(400).json({ error: 'Missing shop param' });
  }

  await shopify.auth.begin({
    shop: shopify.utils.sanitizeShop(shop, true),
    callbackPath: '/auth/callback',
    isOnline: false,
    rawRequest: req,
    rawResponse: res,
  });
});

// ─── Auth callback ───
app.get('/auth/callback', async (req, res) => {
  try {
    const callback = await shopify.auth.callback({
      rawRequest: req,
      rawResponse: res,
    });

    const { shop, accessToken } = callback.session;

    req.session.shop_domain = shop;

    // ✅ Save shop
    await supabase.from('shops').upsert({
      shop_domain: shop,
      access_token: accessToken,
    });

    // 🔥 REGISTER WEBHOOK (CRITICAL)
    try {
      await fetch(`https://${shop}/admin/api/2024-01/webhooks.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          webhook: {
            topic: 'carts/update',
            address:
              'https://shopify-cart-recovery-sms.onrender.com/webhooks/carts/update',
            format: 'json',
          },
        }),
      });

      console.log('✅ Webhook registered');
    } catch (err) {
      console.error('Webhook error:', err.message);
    }

    res.redirect('/dashboard');
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Webhook ───
app.post(
  '/webhooks/carts/update',
  verifyShopifyWebhook,
  async (req, res) => {
    const cart = req.body;
    const shopDomain = req.get('X-Shopify-Shop-Domain');

    const phone = cart.phone || cart.customer?.phone;
    if (!phone) return res.status(200).send('No phone');

    await supabase.from('abandoned_carts').insert({
      shop_domain: shopDomain,
      cart_token: cart.token,
      customer_phone: phone,
      cart_total: cart.total_price,
      product_names: (cart.line_items || [])
        .map((i) => i.title)
        .join(', '),
      checkout_url: cart.checkout_url,
      abandoned_at: new Date().toISOString(),
    });

    res.status(200).send('ok');
  }
);

// ─── Dashboard ───
app.get('/dashboard', async (req, res) => {
  const shop = req.session.shop_domain;

  if (!shop) {
    return res.send('No shop session');
  }

  res.send(`Dashboard for ${shop}`);
});

// ─── START SERVER (ONLY ONE) ───
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(
    `Live URL: https://shopify-cart-recovery-sms.onrender.com`
  );

  startScheduler();
});