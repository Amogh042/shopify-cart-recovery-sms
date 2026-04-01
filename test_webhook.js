/**
 * Test script: Sends a fake Shopify cart/update webhook to the local server
 * with a valid HMAC signature so the handler accepts it.
 *
 * Usage: node test_webhook.js
 */
require('dotenv').config();
const crypto = require('crypto');
const http = require('http');

const payload = JSON.stringify({
  id: 987654321,
  token: 'test-cart-token-' + Date.now(),
  email: 'jane.doe@example.com',
  phone: '+15551234567',
  total_price: '149.99',
  checkout_url: 'https://mytest.myshopify.com/checkouts/test-cart-token',
  customer: {
    first_name: 'Jane',
    last_name: 'Doe',
    email: 'jane.doe@example.com',
    phone: '+15551234567',
  },
  line_items: [
    {
      id: 1,
      title: 'Wireless Headphones',
      quantity: 1,
      price: '99.99',
    },
    {
      id: 2,
      title: 'USB-C Cable',
      quantity: 2,
      price: '25.00',
    },
  ],
});

// Generate valid HMAC signature using the same secret the server uses
const hmac = crypto
  .createHmac('sha256', process.env.SHOPIFY_API_SECRET)
  .update(payload)
  .digest('base64');

console.log('📤 Sending fake webhook to POST /webhooks/carts/update');
console.log(`   HMAC: ${hmac}`);
console.log(`   Payload size: ${payload.length} bytes\n`);

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/webhooks/carts/update',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'X-Shopify-Hmac-Sha256': hmac,
    'X-Shopify-Shop-Domain': 'mytest.myshopify.com',
    'X-Shopify-Topic': 'carts/update',
  },
};

const req = http.request(options, (res) => {
  let body = '';
  res.on('data', (chunk) => (body += chunk));
  res.on('end', () => {
    console.log(`📥 Response status: ${res.statusCode}`);
    console.log(`   Body: ${body}`);

    if (res.statusCode === 200) {
      console.log('\n✅ Webhook processed successfully!');
      console.log('   Check Supabase → abandoned_carts table for the new row.');
    } else {
      console.log('\n❌ Webhook failed.');
    }
  });
});

req.on('error', (e) => {
  console.error('❌ Request error:', e.message);
  console.error('   Is the server running? (npm start)');
});

req.write(payload);
req.end();
