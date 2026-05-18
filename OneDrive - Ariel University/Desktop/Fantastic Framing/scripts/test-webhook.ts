#!/usr/bin/env tsx
/**
 * test-webhook — simulate a SendGrid Inbound Parse POST to your live server.
 *
 * Usage:
 *   npm run test-webhook
 *   npm run test-webhook -- --url https://your-custom-url.up.railway.app
 */

import "dotenv/config";

const args = process.argv.slice(2);
const urlArg = args[args.indexOf("--url") + 1];

const BASE_URL = urlArg ?? "https://fantastic-framing-production.up.railway.app";
const TOKEN = process.env.SENDGRID_INBOUND_TOKEN!;

if (!TOKEN) {
  console.error("❌  SENDGRID_INBOUND_TOKEN not set in .env");
  process.exit(1);
}

const body = new FormData();
body.append("headers", "Message-ID: <test-order-001@fantastic-framing-test.com>\r\nDate: Mon, 18 May 2026 10:00:00 +0000\r\nFrom: Haven Prints <hello@havenprints.com.au>\r\nTo: orders@fantasticframing.com.au\r\nSubject: Haven Prints Order 9999");
body.append("from", "Haven Prints <hello@havenprints.com.au>");
body.append("to", "orders@fantasticframing.com.au");
body.append("subject", "Haven Prints Order 9999");
body.append("text", `Order #9999
1 x oak framed canvas print

--------------------

Artwork Name: Sunset Over Uluru
Size: 90cm (w) x 60cm (h)
Orientation: Landscape
Job Type: Framed Canvas Print
Colour of frame: Oak

--------------------

Customer Details:

Sarah Mitchell
42 Banksia Street
Manly
New South Wales 2095
Australia
+61412345678

Email: sarah.mitchell@gmail.com`);
body.append("html", "");
body.append("attachments", "0");
body.append("spam_score", "0.1");
body.append("SPF", "pass");

const url = `${BASE_URL}/webhooks/inbound-email?token=${TOKEN}`;

console.log(`\nPOSTing test email to ${BASE_URL} …\n`);

const res = await fetch(url, {
  method: "POST",
  body,
});

const json = await res.json();

if (!res.ok) {
  console.error(`❌  ${res.status} ${res.statusText}`);
  console.error(json);
  process.exit(1);
}

console.log(`✅  Accepted — email queued with id: ${json.id}`);
console.log(`\nNow check your Shopify Admin → Orders → Drafts`);
console.log(`https://admin.shopify.com/store/avishag-demo/draft_orders\n`);
