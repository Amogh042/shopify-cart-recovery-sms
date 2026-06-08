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
 * Process first SMS (after 1 hour)
 */
async function processFirstSMS(cart) {
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
      .update({ sms_sent: true, sms_sent_at: new Date().toISOString() })
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
 * Process second SMS (after 24 hours)
 */
async function processSecondSMS(cart) {
  const customerName = cart.customer_name || 'there';
  const productNames = cart.product_names || 'items';
  const checkoutUrl = cart.checkout_url || '';

  const message =
    `Hey ${customerName}, still thinking about ${productNames}?\n` +
    `Here is a 10% discount for you: use code COMEBACK10 at checkout:\n` +
    `${checkoutUrl} — Reply STOP to opt out`;

  console.log(`   📱 Sending 2nd SMS to ${cart.customer_phone}...`);

  let status = 'failed';
  let sentAt = new Date().toISOString();

  try {
    const result = await twilioClient.messages.create({
      body: message,
      from: TWILIO_PHONE,
      to: cart.customer_phone,
    });

    status = result.status || 'sent';
    console.log(`   ✅ 2nd SMS sent — SID: ${result.sid}, Status: ${status}`);

    // Mark second_sms_sent=true after successful send
    const { error: updateErr } = await supabase
      .from('abandoned_carts')
      .update({ second_sms_sent: true, second_sms_sent_at: new Date().toISOString() })
      .eq('id', cart.id);

    if (updateErr) {
      console.error(`   ❌ Failed to update second_sms_sent for cart ${cart.id}: ${updateErr.message}`);
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
    console.error(`   ❌ Failed to log 2nd SMS for cart ${cart.id}: ${logErr.message}`);
  }
}

/**
 * Main job: query abandoned carts for first SMS (1 hour) and second SMS (24 hours)
 */
async function sendAbandonedCartSMS() {
  if (isRunning) {
    console.log('   ⏳ Previous SMS run still in progress — skipping this tick');
    return;
  }

  isRunning = true;

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  console.log(`\n🕐 [${new Date().toLocaleTimeString()}] SMS Scheduler running...`);
  console.log(`   Looking for carts abandoned before ${oneHourAgo} (1st SMS) and ${twentyFourHoursAgo} (2nd SMS)`);

  try {
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !TWILIO_PHONE) {
      console.warn('   ⚠️  Twilio env vars missing — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER');
      return;
    }

    // Process first SMS (1 hour)
    const { data: firstCarts, error: firstError } = await supabase
      .from('abandoned_carts')
      .select(`*
        , shops!inner(is_paid)
      `)
      .eq('sms_sent', false)
      .lt('abandoned_at', oneHourAgo);

    if (firstError) {
      console.error('   ❌ First SMS query error:', firstError.message);
    } else if (firstCarts && firstCarts.length > 0) {
      console.log(`   📦 Found ${firstCarts.length} cart(s) for 1st SMS`);
      for (const cart of firstCarts) {
        // Check if shop is paid
        if (!cart.shops?.is_paid) {
          console.log(`   💰 Unpaid shop - SMS blocked for ${cart.shop_domain}`);
          continue;
        }

        if (!cart.customer_phone) {
          console.log(`   ⏭️  Skipping cart ${cart.id} — no phone number`);
          // Mark as processed to avoid infinite loop
          await supabase.from('abandoned_carts').update({ sms_sent: true }).eq('id', cart.id);
          continue;
        }
        await processFirstSMS(cart);
      }
    }

    // Process second SMS (24 hours)
    const { data: secondCarts, error: secondError } = await supabase
      .from('abandoned_carts')
      .select(`*
        , shops!inner(is_paid)
      `)
      .eq('sms_sent', true)
      .eq('second_sms_sent', false)
      .eq('recovered', false)
      .lt('abandoned_at', twentyFourHoursAgo);

    if (secondError) {
      console.error('   ❌ Second SMS query error:', secondError.message);
    } else if (secondCarts && secondCarts.length > 0) {
      console.log(`   📦 Found ${secondCarts.length} cart(s) for 2nd SMS`);
      for (const cart of secondCarts) {
        // Check if shop is paid
        if (!cart.shops?.is_paid) {
          console.log(`   💰 Unpaid shop - SMS blocked for ${cart.shop_domain}`);
          continue;
        }

        if (!cart.customer_phone) {
          console.log(`   ⏭️  Skipping cart ${cart.id} — no phone number`);
          continue;
        }
        await processSecondSMS(cart);
      }
    }

    if ((!firstCarts || firstCarts.length === 0) && (!secondCarts || secondCarts.length === 0)) {
      console.log('   📭 No abandoned carts to process');
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
