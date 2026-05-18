import { config } from "../config.js";
import type { ExtractionResult, Extraction } from "./extraction.js";
import type { Decision } from "./decision.js";
import type { emails } from "../db/schema.js";

const API_VERSION = "2024-10";

type EmailRow = typeof emails.$inferSelect;

// ─── HTTP helper ──────────────────────────────────────────────────────────────

async function shopifyPost(path: string, body: unknown): Promise<unknown> {
  const url = `https://${config.SHOPIFY_SHOP_DOMAIN}/admin/api/${API_VERSION}/${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": config.SHOPIFY_ADMIN_API_TOKEN,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "(empty body)");
    // Throw for all errors — BullMQ's exponential backoff handles transient 5xx.
    // 4xx errors (bad token, invalid payload) will exhaust retries and surface
    // the email on the admin page for manual handling.
    throw new Error(`Shopify ${res.status} ${res.statusText}: ${text}`);
  }

  return res.json();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function splitName(fullName: string): { first_name: string; last_name: string } {
  const parts = fullName.trim().split(/\s+/);
  return {
    first_name: parts[0] ?? "",
    last_name: parts.slice(1).join(" "),
  };
}

function buildTags(artistName: string, extra: string[]): string {
  return ["agent-generated", `artist:${artistName}`, ...extra].join(", ");
}

/** Direct link to the draft in Shopify Admin — used in the admin HTML page. */
export function shopifyDraftUrl(draftId: string): string {
  return `https://${config.SHOPIFY_SHOP_DOMAIN}/admin/draft_orders/${draftId}`;
}

// ─── Payload builders ─────────────────────────────────────────────────────────

function buildCustomer(data: Extraction) {
  if (!data.customer.name) return undefined;
  const { first_name, last_name } = splitName(data.customer.name);
  return {
    first_name,
    last_name,
    ...(data.customer.email ? { email: data.customer.email } : {}),
    ...(data.customer.phone ? { phone: data.customer.phone } : {}),
  };
}

function buildShippingAddress(data: Extraction) {
  if (!data.shipping_address.line1) return undefined;
  const name = data.customer.name ? splitName(data.customer.name) : undefined;
  return {
    ...(name ? { first_name: name.first_name, last_name: name.last_name } : {}),
    address1: data.shipping_address.line1,
    ...(data.shipping_address.line2 ? { address2: data.shipping_address.line2 } : {}),
    ...(data.shipping_address.city ? { city: data.shipping_address.city } : {}),
    ...(data.shipping_address.postal_code ? { zip: data.shipping_address.postal_code } : {}),
    ...(data.shipping_address.country ? { country: data.shipping_address.country } : {}),
    ...(data.customer.phone ? { phone: data.customer.phone } : {}),
  };
}

function buildLineItems(data: Extraction) {
  return data.line_items.map((item) => ({
    // Combine title + variant into the Shopify line item title (no variant_id lookup in v1)
    title: item.variant ? `${item.title} — ${item.variant}` : item.title,
    price: item.unit_price != null ? item.unit_price.toFixed(2) : "0.00",
    quantity: item.quantity,
  }));
}

// ─── Per-outcome draft builders ───────────────────────────────────────────────

function draftedPayload(
  email: EmailRow,
  artistName: string,
  data: Extraction,
): Record<string, unknown> {
  const customer = buildCustomer(data);
  const shippingAddress = buildShippingAddress(data);

  return {
    draft_order: {
      line_items: buildLineItems(data),
      ...(customer ? { customer } : {}),
      ...(shippingAddress ? { shipping_address: shippingAddress } : {}),
      ...(data.shipping_cost != null
        ? { shipping_line: { price: data.shipping_cost.toFixed(2), title: "Shipping" } }
        : {}),
      note: email.rawBodyText ?? "",
      tags: buildTags(artistName, []),
    },
  };
}

function needsReviewPayload(
  email: EmailRow,
  artistName: string,
  data: Extraction,
  decision: Decision,
): Record<string, unknown> {
  const uncertain = [...decision.missingRequired, ...decision.missingOptional];
  const warningBlock = [
    "⚠️ NEEDS REVIEW",
    `Confidence: ${data.confidence}`,
    `Missing or uncertain fields: ${uncertain.length > 0 ? uncertain.join(", ") : "none"}`,
    "Please verify before converting to an order.",
  ].join("\n");

  const note = [
    warningBlock,
    "",
    "--- Original email ---",
    email.rawBodyText ?? "(no body text)",
  ].join("\n");

  const base = draftedPayload(email, artistName, data);
  const draftOrder = base.draft_order as Record<string, unknown>;

  return {
    draft_order: {
      ...draftOrder,
      note,
      tags: buildTags(artistName, ["needs-review"]),
    },
  };
}

function failedPayload(email: EmailRow, artistName: string): Record<string, unknown> {
  const note = [
    "⚠️ EXTRACTION FAILED",
    "The agent could not parse this order email automatically.",
    "Original email below — please create the order manually.",
    "---",
    email.rawBodyText ?? "(no body text)",
  ].join("\n");

  return {
    draft_order: {
      // Shopify requires at least one line item; use a visible placeholder
      line_items: [
        { title: "⚠️ EXTRACTION FAILED — See Notes", price: "0.00", quantity: 1 },
      ],
      note,
      tags: buildTags(artistName, ["extraction-failed"]),
    },
  };
}

// ─── Public function ──────────────────────────────────────────────────────────

/**
 * Creates a Shopify draft order for every email outcome (drafted, needs_review, failed).
 *
 * Throws on any Shopify API error — BullMQ retries the job up to 3× on transient
 * 5xx errors. Persistent failures (bad token, invalid payload) also exhaust retries
 * and surface the email on the admin page (shopify_draft_id stays null).
 *
 * Returns the Shopify draft order ID as a string.
 */
export async function createShopifyDraft(
  email: EmailRow,
  artistName: string,
  result: ExtractionResult,
  decision: Decision,
): Promise<string> {
  let payload: Record<string, unknown>;

  if (decision.outcome === "failed") {
    payload = failedPayload(email, artistName);
  } else if (decision.outcome === "needs_review") {
    payload = needsReviewPayload(
      email,
      artistName,
      (result as { type: "success"; data: Extraction }).data,
      decision,
    );
  } else {
    payload = draftedPayload(
      email,
      artistName,
      (result as { type: "success"; data: Extraction }).data,
    );
  }

  const res = (await shopifyPost("draft_orders.json", payload)) as {
    draft_order: { id: number; name: string };
  };

  return String(res.draft_order.id);
}
