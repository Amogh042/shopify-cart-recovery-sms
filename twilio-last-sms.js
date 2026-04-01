require('dotenv').config();

const twilio = require('twilio');

async function main() {
  const to = process.argv[2];
  if (!to) {
    // eslint-disable-next-line no-console
    console.error('Usage: node twilio-last-sms.js <toPhoneE164>');
    process.exit(2);
  }

  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  const messages = await client.messages.list({ to, limit: 5 });

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      messages.map((m) => ({
        sid: m.sid,
        to: m.to,
        from: m.from,
        status: m.status,
        dateCreated: m.dateCreated,
        body: m.body,
      })),
      null,
      2
    )
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});

