require('dotenv').config();

const supabase = require('./supabase');

async function main() {
  const cartId = process.argv[2];
  const hours = Number(process.argv[3] || 2);
  if (!cartId) {
    // eslint-disable-next-line no-console
    console.error('Usage: node supabase-backdate-cart.js <cart_id> [hoursAgo=2]');
    process.exit(2);
  }

  const targetIso = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('abandoned_carts')
    .update({ abandoned_at: targetIso, sms_sent: false })
    .eq('id', cartId)
    .select('id, shop_domain, abandoned_at, sms_sent')
    .maybeSingle();

  if (error) {
    // eslint-disable-next-line no-console
    console.error('Supabase error:', error.message);
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ updated: data }, null, 2));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});

