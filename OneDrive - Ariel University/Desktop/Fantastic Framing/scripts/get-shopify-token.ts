#!/usr/bin/env tsx
/**
 * get-shopify-token — exchange Shopify Custom App client credentials for an
 * Admin API access token using the OAuth 2.0 client_credentials grant flow.
 *
 * Run this ONCE after you install your custom app in the Shopify Admin.
 * Copy the printed token into SHOPIFY_ADMIN_API_TOKEN in your .env file.
 *
 * Usage:
 *   npm run get-shopify-token
 *
 * Required env vars (add these to your .env first):
 *   SHOPIFY_SHOP_DOMAIN   e.g. your-shop.myshopify.com
 *   SHOPIFY_CLIENT_ID     from Shopify Admin → Apps → your app → API credentials
 *   SHOPIFY_CLIENT_SECRET from Shopify Admin → Apps → your app → API credentials
 */

import "dotenv/config";

const domain = process.env.SHOPIFY_SHOP_DOMAIN?.trim();
const clientId = process.env.SHOPIFY_CLIENT_ID?.trim();
const clientSecret = process.env.SHOPIFY_CLIENT_SECRET?.trim();

if (!domain || !clientId || !clientSecret) {
  console.error(`
❌  Missing required environment variables.

Make sure these are set in your .env file:

  SHOPIFY_SHOP_DOMAIN   e.g. your-shop.myshopify.com
  SHOPIFY_CLIENT_ID     from Shopify Admin → Apps → your app → API credentials
  SHOPIFY_CLIENT_SECRET from Shopify Admin → Apps → your app → API credentials
`);
  process.exit(1);
}

const url = `https://${domain}/admin/oauth/access_token`;

console.log(`\nRequesting access token from ${url} …\n`);

const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
  }),
});

if (!res.ok) {
  const text = await res.text().catch(() => "(empty body)");
  console.error(`❌  Shopify returned ${res.status} ${res.statusText}`);
  console.error(text);
  console.error(`
Troubleshooting tips:
  • Make sure the app is fully installed in your Shopify Admin.
  • Double-check SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET — copy them
    directly from Shopify Admin → Settings → Apps → your app → API credentials.
  • Make sure SHOPIFY_SHOP_DOMAIN is just the domain, e.g. my-shop.myshopify.com
    (no https://, no trailing slash).
`);
  process.exit(1);
}

const json = (await res.json()) as Record<string, unknown>;

const token = json.access_token as string | undefined;

if (!token) {
  console.error("❌  Response did not contain an access_token:");
  console.error(JSON.stringify(json, null, 2));
  process.exit(1);
}

console.log("✅  Success!\n");
console.log("Copy this token into SHOPIFY_ADMIN_API_TOKEN in your .env file:\n");
console.log(`  SHOPIFY_ADMIN_API_TOKEN=${token}`);
console.log();

if (json.scope) {
  console.log(`Granted scopes: ${json.scope}`);
  console.log();
}
