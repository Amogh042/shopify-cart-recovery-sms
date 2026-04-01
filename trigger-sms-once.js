require('dotenv').config();

const { sendAbandonedCartSMS } = require('./sms-scheduler');

async function main() {
  await sendAbandonedCartSMS();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});

