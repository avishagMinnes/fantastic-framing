# Fantastic Framing — Artist Order Email → Shopify Draft Agent

This service ingests artist order emails via SendGrid Inbound Parse, uses Claude (Anthropic) to extract structured order data from the email body, and automatically creates Shopify draft orders. Incoming emails are queued via BullMQ + Redis so that processing is resilient to transient failures. All emails and extraction attempts are persisted to Postgres for auditing and manual review.

## Local Dev Setup

```bash
# 1. Start Postgres and Redis
docker-compose up -d

# 2. Install dependencies
npm install

# 3. Copy and fill in environment variables
cp .env.example .env
# Edit .env with your real API keys

# 4. Run database migrations
npm run db:migrate

# 5. Start the dev server (hot-reload)
npm run dev
```

The server starts on `http://localhost:3000`. Visit `/healthz` to verify it is running.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for Claude |
| `SHOPIFY_SHOP_DOMAIN` | Yes | e.g. `your-shop.myshopify.com` |
| `SHOPIFY_ADMIN_API_TOKEN` | Yes | Shopify Admin API access token (`shpat_...`) |
| `SENDGRID_INBOUND_TOKEN` | Yes | Long random string appended to the SendGrid Inbound Parse webhook URL for auth |
| `DATABASE_URL` | Yes | Postgres connection string |
| `REDIS_URL` | Yes | Redis connection string |
| `ADMIN_API_SECRET` | Yes | Secret for the admin UI/API |
| `PORT` | No | HTTP port (default: `3000`) |
| `NODE_ENV` | No | `development` / `production` / `test` (default: `development`) |

## Architecture

- **Fastify** — HTTP server; receives SendGrid Inbound Parse webhooks and serves the admin UI
- **SendGrid Inbound Parse** — forwards inbound artist emails as multipart form-data POST requests
- **BullMQ + Redis** — durable job queue; each inbound email is enqueued so extraction and Shopify calls are retried on failure
- **Claude (Anthropic SDK)** — extracts structured order line-items, shipping details, and customer info from raw email text
- **Drizzle ORM + Postgres** — persists raw emails, extraction logs, and artist profiles; provides audit trail and review queue
- **Shopify Admin API** — creates draft orders from extracted data for staff review and confirmation

## Manual Step: Enable Shopify Staff Notifications

Shopify does not automatically notify staff when a draft order is created via the API. After setup, go to **Shopify Admin → Settings → Notifications → Staff order notifications** and enable draft order notifications for the relevant staff members.
