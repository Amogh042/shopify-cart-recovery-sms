require('dotenv').config();
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const shopify = require('./shopify');
const supabase = require('./supabase');
const { startScheduler } = require('./sms-scheduler');

if (!process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET environment variable is required. Set it in .env before starting the server.');
}

// ─── HTML escape to prevent XSS in dashboard templates ───
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(
  session({
    name: 'shopify_plugin_sid',
    secret: process.env.SESSION_SECRET,
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

// ─── Raw body for Shopify webhooks, form-encoded for Twilio inbound ───
app.use('/webhooks/twilio', express.urlencoded({ extended: false }));
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
  const error = req.query.error;
  const message = req.query.message;

  // If there's an error but no shop, show error message
  if (error && !shop) {
    return res.status(400).send(`
      <h2>Authentication Error</h2>
      <p>${message || 'Unknown error occurred'}</p>
      <p>Please access the app through Shopify admin or provide a shop parameter.</p>
      <a href="/">Go back</a>
    `);
  }

  if (!shop) {
    return res.status(400).send(`
      <h2>Missing Shop Parameter</h2>
      <p>Please access the app through Shopify admin or provide a shop parameter.</p>
      <a href="/">Go back</a>
    `);
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

    // ✅ Save shop (re-activate on reinstall)
    await supabase.from('shops').upsert({
      shop_domain: shop,
      access_token: accessToken,
      is_active: true,
    });

    // 🔥 REGISTER WEBHOOKS (CRITICAL)
    try {
      // Register carts/update webhook
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
              `${process.env.HOST}/webhooks/carts/update`,
            format: 'json',
          },
        }),
      });

      // Register orders/create webhook for recovery tracking
      await fetch(`https://${shop}/admin/api/2024-01/webhooks.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          webhook: {
            topic: 'orders/create',
            address:
              `${process.env.HOST}/webhooks/orders/create`,
            format: 'json',
          },
        }),
      });

      // Register app/uninstalled webhook
      await fetch(`https://${shop}/admin/api/2024-01/webhooks.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          webhook: {
            topic: 'app/uninstalled',
            address:
              `${process.env.HOST}/webhooks/app/uninstalled`,
            format: 'json',
          },
        }),
      });

      // Register GDPR webhooks
      const gdprTopics = [
        { topic: 'customers/data_request', path: '/webhooks/gdpr/customers-data-request' },
        { topic: 'customers/redact', path: '/webhooks/gdpr/customers-redact' },
        { topic: 'shop/redact', path: '/webhooks/gdpr/shop-redact' },
      ];

      for (const { topic, path } of gdprTopics) {
        await fetch(`https://${shop}/admin/api/2024-01/webhooks.json`, {
          method: 'POST',
          headers: {
            'X-Shopify-Access-Token': accessToken,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            webhook: {
              topic,
              address: `${process.env.HOST}${path}`,
              format: 'json',
            },
          }),
        });
      }

      console.log('✅ Webhooks registered (carts/update, orders/create, app/uninstalled, GDPR x3)');
    } catch (err) {
      console.error('Webhook error:', err.message);
    }

    // 🏷️ AUTO-CREATE COMEBACK10 DISCOUNT CODE
    try {
      // Step 1: Create a price rule (10% off entire order)
      const priceRuleRes = await fetch(`https://${shop}/admin/api/2024-01/price_rules.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          price_rule: {
            title: 'COMEBACK10',
            target_type: 'line_item',
            target_selection: 'all',
            allocation_method: 'across',
            value_type: 'percentage',
            value: '-10.0',
            customer_selection: 'all',
            starts_at: new Date().toISOString(),
            usage_limit: null,
            once_per_customer: true,
          },
        }),
      });

      const priceRuleData = await priceRuleRes.json();

      if (priceRuleData.price_rule) {
        // Step 2: Create a discount code linked to the price rule
        const priceRuleId = priceRuleData.price_rule.id;

        await fetch(`https://${shop}/admin/api/2024-01/price_rules/${priceRuleId}/discount_codes.json`, {
          method: 'POST',
          headers: {
            'X-Shopify-Access-Token': accessToken,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            discount_code: { code: 'COMEBACK10' },
          }),
        });

        // Mark discount as created in shops table
        await supabase
          .from('shops')
          .update({ discount_code_created: true })
          .eq('shop_domain', shop);

        console.log('✅ Discount code COMEBACK10 created');
      } else if (priceRuleData.errors) {
        // Code likely already exists — mark as created anyway
        console.log('ℹ️ Discount code may already exist:', JSON.stringify(priceRuleData.errors));
        await supabase
          .from('shops')
          .update({ discount_code_created: true })
          .eq('shop_domain', shop);
      }
    } catch (err) {
      console.error('Discount code creation error:', err.message);
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

    const customerName = cart.customer?.first_name || null;

    await supabase.from('abandoned_carts').upsert(
      {
        shop_domain: shopDomain,
        cart_token: cart.token,
        customer_phone: phone,
        customer_name: customerName,
        cart_total: cart.total_price,
        product_names: (cart.line_items || [])
          .map((i) => i.title)
          .join(', '),
        checkout_url: cart.checkout_url,
        abandoned_at: new Date().toISOString(),
      },
      { onConflict: 'shop_domain,cart_token' }
    );

    res.status(200).send('ok');
  }
);

// ─── Orders Webhook (Recovery Tracking) ───
app.post(
  '/webhooks/orders/create',
  verifyShopifyWebhook,
  async (req, res) => {
    const order = req.body;
    const shopDomain = req.get('X-Shopify-Shop-Domain');

    // Extract customer phone number from order
    const phone = order.phone || order.customer?.phone;
    if (!phone) {
      console.log('📞 No phone number in order, skipping recovery check');
      return res.status(200).send('No phone');
    }

    console.log(`🛒 New order received from ${phone} at ${shopDomain}`);

    try {
      // Look for abandoned carts matching criteria
      const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      
      const { data: carts, error } = await supabase
        .from('abandoned_carts')
        .select('*')
        .eq('shop_domain', shopDomain)
        .eq('customer_phone', phone)
        .eq('sms_sent', true)
        .eq('recovered', false)
        .gte('abandoned_at', fortyEightHoursAgo)
        .order('abandoned_at', { ascending: false })
        .limit(1);

      if (error) {
        console.error('❌ Error querying abandoned carts:', error.message);
        return res.status(500).send('Database error');
      }

      if (!carts || carts.length === 0) {
        console.log(`📭 No matching abandoned cart found for ${phone}`);
        return res.status(200).send('No matching cart');
      }

      // Found matching cart - mark as recovered
      const cart = carts[0];
      console.log(`✅ Found matching cart ${cart.id}, marking as recovered`);

      const { error: updateError } = await supabase
        .from('abandoned_carts')
        .update({
          recovered: true,
          recovered_at: new Date().toISOString(),
          order_id: order.id.toString(),
          recovery_order_total: order.total_price
        })
        .eq('id', cart.id);

      if (updateError) {
        console.error('❌ Error updating cart recovery:', updateError.message);
        return res.status(500).send('Update error');
      }

      console.log(`🎉 Cart ${cart.id} recovered! Order total: $${order.total_price}`);
      res.status(200).send('Cart recovered');

    } catch (error) {
      console.error('❌ Unexpected error in order webhook:', error.message);
      res.status(500).send('Server error');
    }
  }
);

// ─── Twilio Inbound SMS (opt-out handling) ───
app.post('/webhooks/twilio/inbound', async (req, res) => {
  const from = req.body.From;
  const body = (req.body.Body || '').trim().toUpperCase();

  if (!from) return res.status(200).type('text/xml').send('<Response/>');

  const optOutKeywords = ['STOP', 'UNSUBSCRIBE', 'CANCEL', 'QUIT', 'END'];

  if (optOutKeywords.includes(body)) {
    console.log(`🚫 Opt-out received from ${from}`);

    const { error } = await supabase
      .from('sms_optouts')
      .upsert({ phone_number: from, opted_out_at: new Date().toISOString() }, { onConflict: 'phone_number' });

    if (error) {
      console.error(`❌ Failed to save opt-out for ${from}: ${error.message}`);
    }
  }

  res.status(200).type('text/xml').send('<Response/>');
});

// ─── App Uninstalled Webhook ───
app.post(
  '/webhooks/app/uninstalled',
  verifyShopifyWebhook,
  async (req, res) => {
    const shopDomain = req.get('X-Shopify-Shop-Domain');
    console.log(`🗑️ App uninstalled by ${shopDomain}`);

    const { error } = await supabase
      .from('shops')
      .update({ is_active: false })
      .eq('shop_domain', shopDomain);

    if (error) {
      console.error(`❌ Failed to deactivate shop ${shopDomain}: ${error.message}`);
    }

    res.status(200).send('ok');
  }
);

// ─── GDPR Webhooks ───
app.post(
  '/webhooks/gdpr/customers-data-request',
  verifyShopifyWebhook,
  async (req, res) => {
    const payload = req.body;
    console.log(`📋 GDPR data request received for shop ${payload.shop_domain}`, JSON.stringify(payload));
    res.status(200).send('ok');
  }
);

app.post(
  '/webhooks/gdpr/customers-redact',
  verifyShopifyWebhook,
  async (req, res) => {
    const payload = req.body;
    const phone = payload.customer?.phone;
    const shopDomain = payload.shop_domain;

    console.log(`🧹 GDPR customer redact for ${phone} at ${shopDomain}`);

    if (phone) {
      const { data: carts } = await supabase
        .from('abandoned_carts')
        .select('id')
        .eq('shop_domain', shopDomain)
        .eq('customer_phone', phone);

      if (carts && carts.length > 0) {
        const cartIds = carts.map((c) => c.id);
        await supabase.from('sms_logs').delete().in('cart_id', cartIds);
        await supabase.from('abandoned_carts').delete().in('id', cartIds);
      }

      await supabase.from('sms_optouts').delete().eq('phone_number', phone);
    }

    res.status(200).send('ok');
  }
);

app.post(
  '/webhooks/gdpr/shop-redact',
  verifyShopifyWebhook,
  async (req, res) => {
    const shopDomain = req.body.shop_domain;
    console.log(`🧹 GDPR shop redact for ${shopDomain}`);

    const { data: carts } = await supabase
      .from('abandoned_carts')
      .select('id')
      .eq('shop_domain', shopDomain);

    if (carts && carts.length > 0) {
      const cartIds = carts.map((c) => c.id);
      await supabase.from('sms_logs').delete().in('cart_id', cartIds);
    }

    await supabase.from('abandoned_carts').delete().eq('shop_domain', shopDomain);
    await supabase.from('shops').delete().eq('shop_domain', shopDomain);

    res.status(200).send('ok');
  }
);

// ─── Dashboard ───
app.get('/dashboard', async (req, res) => {
  // First priority: session.shop_domain (set after OAuth)
  let shop = req.session.shop_domain;
  
  // Second priority: req.query.shop (fallback for direct URL access)
  if (!shop && req.query.shop) {
    shop = shopify.utils.sanitizeShop(req.query.shop, true);
  }
  
  // If neither exists, redirect to /auth with error message
  if (!shop) {
    return res.redirect('/auth?error=no_shop&message=No shop in session. Please authenticate again.');
  }

  try {
    // Get shop's paid status
    const { data: shopData, error: shopError } = await supabase
      .from('shops')
      .select('is_paid')
      .eq('shop_domain', shop)
      .single();

    if (shopError) {
      console.error('Error fetching shop data:', shopError.message);
      return res.status(500).send('Error loading shop data');
    }

    // Get dashboard statistics
    const { data: allCarts, error: cartsError } = await supabase
      .from('abandoned_carts')
      .select('*')
      .eq('shop_domain', shop);

    if (cartsError) {
      console.error('Error fetching dashboard data:', cartsError.message);
      return res.status(500).send('Error loading dashboard data');
    }

    // Calculate statistics
    const totalCarts = allCarts?.length || 0;
    const smsSent = allCarts?.filter(cart => cart.sms_sent).length || 0;
    const secondSmsSent = allCarts?.filter(cart => cart.second_sms_sent).length || 0;
    const recovered = allCarts?.filter(cart => cart.recovered).length || 0;
    
    // Calculate recovered revenue (sum of cart_total where recovered = true)
    const recoveredRevenue = allCarts
      ?.filter(cart => cart.recovered)
      ?.reduce((sum, cart) => sum + (parseFloat(cart.cart_total) || 0), 0) || 0;

    // Calculate potential revenue (sum of all cart_total)
    const potentialRevenue = allCarts
      ?.reduce((sum, cart) => sum + (parseFloat(cart.cart_total) || 0), 0) || 0;

    // Calculate recovery rate
    const recoveryRate = smsSent > 0 ? ((recovered / smsSent) * 100).toFixed(1) : '0.0';

    // Get recent recovered carts
    const recentRecovered = allCarts
      ?.filter(cart => cart.recovered)
      ?.sort((a, b) => new Date(b.recovered_at) - new Date(a.recovered_at))
      ?.slice(0, 5) || [];

    // Generate HTML dashboard
    const dashboardHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Cart Recovery Dashboard - ${escapeHtml(shop)}</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #f6f6f7; }
          .container { max-width: 1200px; margin: 0 auto; }
          .header { background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
          .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin-bottom: 20px; }
          .stat-card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
          .stat-value { font-size: 2em; font-weight: bold; color: #059669; margin-bottom: 5px; }
          .stat-label { color: #6b7280; font-size: 0.9em; }
          .recovered { color: #059669; }
          .pending { color: #d97706; }
          .section { background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
          .section h2 { margin-top: 0; color: #374151; }
          table { width: 100%; border-collapse: collapse; }
          th, td { padding: 12px; text-align: left; border-bottom: 1px solid #e5e7eb; }
          th { background: #f9fafb; font-weight: 600; color: #374151; }
          .recovered-badge { background: #059669; color: white; padding: 4px 8px; border-radius: 4px; font-size: 0.8em; }
        </style>
      </head>
      <body>
        <div class="container">
          ${!shopData.is_paid ? `
            <div class="unpaid-banner" style="
              background: #dc2626;
              color: white;
              padding: 15px 20px;
              border-radius: 8px;
              margin-bottom: 20px;
              text-align: center;
              font-weight: 600;
              box-shadow: 0 2px 4px rgba(220, 38, 38, 0.2);
            ">
              ⚠️ Your account is not active. Please contact support to activate.
            </div>
          ` : ''}
          
          <div class="header">
            <h1>🛒 Cart Recovery Dashboard</h1>
            <p style="color: #6b7280; margin: 5px 0;">Shop: <strong>${escapeHtml(shop)}</strong></p>
          </div>

          <div class="stats-grid">
            <div class="stat-card">
              <div class="stat-value">${totalCarts}</div>
              <div class="stat-label">Total Abandoned Carts</div>
            </div>
            <div class="stat-card">
              <div class="stat-value">${smsSent}</div>
              <div class="stat-label">First SMS Sent</div>
            </div>
            <div class="stat-card">
              <div class="stat-value">${secondSmsSent}</div>
              <div class="stat-label">Second SMS Sent</div>
            </div>
            <div class="stat-card">
              <div class="stat-value recovered">${recovered}</div>
              <div class="stat-label">Carts Recovered</div>
            </div>
            <div class="stat-card">
              <div class="stat-value recovered">$${recoveredRevenue.toFixed(2)}</div>
              <div class="stat-label">TOTAL REVENUE RECOVERED</div>
            </div>
            <div class="stat-card">
              <div class="stat-value">${recoveryRate}%</div>
              <div class="stat-label">Recovery Rate</div>
            </div>
          </div>

          <div class="section">
            <h2>🎉 Recent Recoveries</h2>
            ${recentRecovered.length > 0 ? `
              <table>
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>Products</th>
                    <th>Cart Total</th>
                    <th>Recovered At</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  ${recentRecovered.map(cart => `
                    <tr>
                      <td>${escapeHtml(cart.customer_name || 'Unknown')}</td>
                      <td>${escapeHtml(cart.product_names || 'N/A')}</td>
                      <td>$${parseFloat(cart.cart_total || 0).toFixed(2)}</td>
                      <td>${escapeHtml(new Date(cart.recovered_at).toLocaleString())}</td>
                      <td><span class="recovered-badge">Recovered</span></td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            ` : '<p style="color: #6b7280;">No recovered carts yet.</p>'}
          </div>

          <div class="section">
            <h2>📊 Summary</h2>
            <p><strong>Potential Revenue:</strong> $${potentialRevenue.toFixed(2)}</p>
            <p><strong>Recovered Revenue:</strong> $${recoveredRevenue.toFixed(2)} (${((recoveredRevenue / potentialRevenue) * 100).toFixed(1)}% of potential)</p>
            <p><strong>Recovery Rate:</strong> ${recoveryRate}% of customers who received SMS</p>
          </div>
        </div>
      </body>
      </html>
    `;

    res.send(dashboardHtml);

  } catch (error) {
    console.error('Dashboard error:', error.message);
    res.status(500).send('Error loading dashboard');
  }
});

// ─── START SERVER (ONLY ONE) ───
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Live URL: ${process.env.HOST}`);

  startScheduler();
});