const cron = require('node-cron');
const twilio = require('twilio');
const supabase = require('./supabase');

// Initialize Twilio client
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const TWILIO_PHONE = process.env.TWILIO_PHONE_NUMBER;

let isRunning = false;

/**
 * Process a single abandoned cart: send SMS, update row, log to sms_logs.
 */
async function processCart(cart) {
  const customerName = cart.customer_name || 'there';
  const productNames = cart.product_names || 'items';
  const checkoutUrl = cart.checkout_url || '';

  const message =
    `Hey ${customerName}! You left ${productNames} in your cart.\n` +
    `Complete your order: ${checkoutUrl}  — Reply STOP to opt out`;

  console.log(`   📱 Sending SMS to ${cart.customer_phone}...`);

  let status = 'failed';
  let sentAt = new Date().toISOString();

  try {
    const result = await twilioClient.messages.create({
      body: message,
      from: TWILIO_PHONE,
      to: cart.customer_phone,
    });

    status = result.status || 'sent';
    console.log(`   ✅ SMS sent — SID: ${result.sid}, Status: ${status}`);

    // Only mark sms_sent=true after a successful Twilio send call
    const { error: updateErr } = await supabase
      .from('abandoned_carts')
      .update({ sms_sent: true })
      .eq('id', cart.id);

    if (updateErr) {
      console.error(`   ❌ Failed to update sms_sent for cart ${cart.id}: ${updateErr.message}`);
    }
  } catch (err) {
    console.error(`   ❌ Twilio error for ${cart.customer_phone}: ${err.message}`);
    status = `error: ${err.message.substring(0, 100)}`;
  }

  // Log to sms_logs table
  const { error: logErr } = await supabase
    .from('sms_logs')
    .insert({
      cart_id: cart.id,
      phone_number: cart.customer_phone,
      message_sent: message,
      sent_at: sentAt,
      status: status,
    });

  if (logErr) {
    console.error(`   ❌ Failed to log SMS for cart ${cart.id}: ${logErr.message}`);
  }
}

/**
 * Main job: query abandoned carts older than 1 hour that haven't been SMS'd.
 */
async function sendAbandonedCartSMS() {
  if (isRunning) {
    console.log('   ⏳ Previous SMS run still in progress — skipping this tick');
    return;
  }

  isRunning = true;

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  console.log(`\n🕐 [${new Date().toLocaleTimeString()}] SMS Scheduler running...`);
  console.log(`   Looking for carts abandoned before ${oneHourAgo}`);

  try {
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !TWILIO_PHONE) {
      console.warn('   ⚠️  Twilio env vars missing — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER');
      return;
    }

    const { data: carts, error } = await supabase
      .from('abandoned_carts')
      .select('*')
      .eq('sms_sent', false)
      .lt('abandoned_at', oneHourAgo);

    if (error) {
      console.error('   ❌ Supabase query error:', error.message);
      return;
    }

    if (!carts || carts.length === 0) {
      console.log('   📭 No abandoned carts to process');
      return;
    }

    console.log(`   📦 Found ${carts.length} cart(s) to process`);

    for (const cart of carts) {
      if (!cart.customer_phone) {
        console.log(`   ⏭️  Skipping cart ${cart.id} — no phone number`);

        const customerName = cart.customer_name || 'there';
        const productNames = cart.product_names || 'items';
        const checkoutUrl = cart.checkout_url || '';
        const message =
          `Hey ${customerName}! You left ${productNames} in your cart.\n` +
          `Complete your order: ${checkoutUrl}  — Reply STOP to opt out`;

        // Prevent re-processing forever
        const { error: updateErr } = await supabase
          .from('abandoned_carts')
          .update({ sms_sent: true })
          .eq('id', cart.id);
        if (updateErr) {
          console.error(`   ❌ Failed to update sms_sent for cart ${cart.id}: ${updateErr.message}`);
        }

        const { error: logErr } = await supabase.from('sms_logs').insert({
          cart_id: cart.id,
          phone_number: null,
          message_sent: message,
          sent_at: new Date().toISOString(),
          status: 'skipped_no_phone',
        });
        if (logErr) {
          console.error(`   ❌ Failed to log skipped cart ${cart.id}: ${logErr.message}`);
        }

        continue;
      }

      await processCart(cart);
    }

    console.log('   🏁 SMS batch complete\n');
  } finally {
    isRunning = false;
  }
}

/**
 * Start the cron scheduler — runs every 5 minutes.
 */
function startScheduler() {
  console.log('⏰ SMS Scheduler started — runs every 5 minutes');

  // Run every 5 minutes: "*/5 * * * *"
  cron.schedule('*/5 * * * *', () => {
    sendAbandonedCartSMS().catch((err) => {
      console.error('SMS Scheduler error:', err.message);
    });
  });

  // Also run once immediately on startup for visibility
  console.log('   Running initial check...');
  sendAbandonedCartSMS().catch((err) => {
    console.error('Initial SMS check error:', err.message);
  });
}

module.exports = { startScheduler, sendAbandonedCartSMS };
