require('dotenv').config();

const supabase = require('./supabase');

async function main() {
  const shop = process.argv[2];
  if (!shop) {
    // eslint-disable-next-line no-console
    console.error('Usage: node supabase-latest-cart.js <shop_domain>');
    process.exit(2);
  }

  const { data, error } = await supabase
    .from('abandoned_carts')
    .select('id, shop_domain, customer_name, customer_phone, product_names, cart_total, sms_sent, recovered, abandoned_at, checkout_url')
    .eq('shop_domain', shop)
    .order('abandoned_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    // eslint-disable-next-line no-console
    console.error('Supabase error:', error.message);
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(data, null, 2));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});

