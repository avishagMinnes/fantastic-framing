import type { ExtractionResult, Extraction } from "./extraction.js";

export type Outcome = "drafted" | "needs_review" | "failed";

export interface Decision {
  outcome: Outcome;
  /** Fields that caused the outcome to be "failed" (required but null). */
  missingRequired: string[];
  /** Fields that are null but not blocking — surfaced in the needs_review note. */
  missingOptional: string[];
}

// ─── Field definitions ────────────────────────────────────────────────────────

const REQUIRED: Array<{ label: string; check: (d: Extraction) => boolean }> = [
  { label: "customer.name",              check: (d) => d.customer.name !== null },
  { label: "shipping_address.line1",     check: (d) => d.shipping_address.line1 !== null },
  { label: "shipping_address.city",      check: (d) => d.shipping_address.city !== null },
  { label: "shipping_address.country",   check: (d) => d.shipping_address.country !== null },
  // line_items.length >= 1 is enforced by the Zod schema, so no check needed here
];

// These don't gate the outcome but are surfaced in the needs_review annotation.
const OPTIONAL: Array<{ label: string; check: (d: Extraction) => boolean }> = [
  { label: "customer.email",             check: (d) => d.customer.email !== null },
  { label: "customer.phone",             check: (d) => d.customer.phone !== null },
  { label: "shipping_address.postal_code", check: (d) => d.shipping_address.postal_code !== null },
  { label: "order_reference",            check: (d) => d.order_reference !== null },
  {
    // At least one line item has a price — missing price is fine (v1 uses Shopify product price),
    // but if ALL items have null price it's worth flagging for review.
    label: "line_items[*].unit_price (all null)",
    check: (d) => d.line_items.some((i) => i.unit_price !== null),
  },
];

// ─── Decision function ────────────────────────────────────────────────────────

/**
 * Maps an ExtractionResult to an outcome used to tag and route the Shopify draft.
 *
 * Matrix:
 *   extraction failed                            → failed
 *   all required present + confidence=high       → drafted
 *   all required present + confidence=medium/low → needs_review
 *   any required field missing                   → failed
 */
export function decideOutcome(result: ExtractionResult): Decision {
  // Extraction itself failed (parse error or Zod validation failure)
  if (result.type === "failed") {
    return { outcome: "failed", missingRequired: [], missingOptional: [] };
  }

  const { data } = result;

  const missingRequired = REQUIRED.filter((f) => !f.check(data)).map((f) => f.label);
  const missingOptional = OPTIONAL.filter((f) => !f.check(data)).map((f) => f.label);

  if (missingRequired.length > 0) {
    return { outcome: "failed", missingRequired, missingOptional };
  }

  if (data.confidence === "high") {
    return { outcome: "drafted", missingRequired: [], missingOptional };
  }

  // confidence is medium or low — required fields present but Claude wasn't certain
  return { outcome: "needs_review", missingRequired: [], missingOptional };
}
