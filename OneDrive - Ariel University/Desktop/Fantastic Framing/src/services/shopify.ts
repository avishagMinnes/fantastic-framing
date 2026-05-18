import { config } from "../config.js";
import type { ExtractionResult, Extraction } from "./extraction.js";
import type { Decision } from "./decision.js";
import type { emails } from "../db/schema.js";

const API_VERSION = "2024-10";

type EmailRow = typeof emails.$inferSelect;

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function shopifyRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  const url = `https://${config.SHOPIFY_SHOP_DOMAIN}/admin/api/${API_VERSION}/${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": config.SHOPIFY_ADMIN_API_TOKEN,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "(empty body)");
    throw new Error(`Shopify ${res.status} ${res.statusText}: ${text}`);
  }

  return res.json();
}

async function shopifyPost(path: string, body: unknown): Promise<unknown> {
  return shopifyRequest("POST", path, body);
}

async function shopifyGet(path: string): Promise<unknown> {
  return shopifyRequest("GET", path);
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

// ─── Customer lookup / creation ───────────────────────────────────────────────

/**
 * Finds an existing Shopify customer by email or creates a new one.
 * Returns the Shopify customer ID so the draft order can reference them by ID,
 * which ensures the customer name appears correctly in the Contact section.
 * Falls back to undefined (inline customer object) on any API error.
 */
async function findOrCreateCustomer(data: Extraction): Promise<number | undefined> {
  if (!data.customer.email && !data.customer.name) return undefined;

  try {
    // Search for existing customer by email first
    if (data.customer.email) {
      const searchRes = await shopifyGet(
        `customers/search.json?query=email:${encodeURIComponent(data.customer.email)}&limit=1`,
      ) as { customers: Array<{ id: number }> };

      if (searchRes.customers.length > 0) {
        return searchRes.customers[0].id;
      }
    }

    // No existing customer — create one
    const { first_name, last_name } = data.customer.name
      ? splitName(data.customer.name)
      : { first_name: "", last_name: "" };

    const createRes = await shopifyPost("customers.json", {
      customer: {
        first_name,
        last_name,
        ...(data.customer.email ? { email: data.customer.email } : {}),
        ...(data.customer.phone ? { phone: data.customer.phone } : {}),
      },
    }) as { customer: { id: number } };

    return createRes.customer.id;
  } catch {
    // Non-fatal — fall back to inline customer object on the draft order
    return undefined;
  }
}

// ─── Payload builders ─────────────────────────────────────────────────────────

function buildCustomer(data: Extraction, shopifyCustomerId?: number) {
  if (shopifyCustomerId) return { id: shopifyCustomerId };
  if (!data.customer.name && !data.customer.email) return undefined;
  const { first_name, last_name } = data.customer.name
    ? splitName(data.customer.name)
    : { first_name: "", last_name: "" };
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

function buildNoteAttributes(data: Extraction): Array<{ name: string; value: string }> {
  const attrs: Array<{ name: string; value: string }> = [];
  if (data.order_reference) {
    attrs.push({ name: "Order Reference", value: data.order_reference });
  }
  return attrs;
}

function draftedPayload(
  email: EmailRow,
  artistName: string,
  data: Extraction,
  shopifyCustomerId?: number,
): Record<string, unknown> {
  const customer = buildCustomer(data, shopifyCustomerId);
  const shippingAddress = buildShippingAddress(data);
  const noteAttributes = buildNoteAttributes(data);

  return {
    draft_order: {
      line_items: buildLineItems(data),
      ...(customer ? { customer } : {}),
      // Set email + phone directly on the draft so the Contact section is
      // always populated, even if customer linking fails or has no ID yet.
      ...(data.customer.email ? { email: data.customer.email } : {}),
      ...(shippingAddress ? { shipping_address: shippingAddress } : {}),
      ...(data.shipping_cost != null
        ? { shipping_line: { price: data.shipping_cost.toFixed(2), title: "Shipping" } }
        : {}),
      note: email.rawBodyText ?? "",
      tags: buildTags(artistName, []),
      ...(noteAttributes.length > 0 ? { note_attributes: noteAttributes } : {}),
    },
  };
}

function needsReviewPayload(
  email: EmailRow,
  artistName: string,
  data: Extraction,
  decision: Decision,
  shopifyCustomerId?: number,
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

  const base = draftedPayload(email, artistName, data, shopifyCustomerId);
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
  } else {
    const data = (result as { type: "success"; data: Extraction }).data;
    // Find or create the Shopify customer so the draft Contact section shows
    // the customer name correctly (referencing by ID is more reliable than
    // passing inline first_name/last_name).
    const shopifyCustomerId = await findOrCreateCustomer(data);

    if (decision.outcome === "needs_review") {
      payload = needsReviewPayload(email, artistName, data, decision, shopifyCustomerId);
    } else {
      payload = draftedPayload(email, artistName, data, shopifyCustomerId);
    }
  }

  const res = (await shopifyPost("draft_orders.json", payload)) as {
    draft_order: { id: number; name: string };
  };

  return String(res.draft_order.id);
}
