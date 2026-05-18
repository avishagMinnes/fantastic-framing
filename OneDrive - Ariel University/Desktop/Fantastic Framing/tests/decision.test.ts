import { describe, it, expect } from "vitest";
import { decideOutcome } from "../src/services/decision.js";
import type { ExtractionResult } from "../src/services/extraction.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function success(overrides: Record<string, unknown> = {}): ExtractionResult {
  return {
    type: "success",
    data: {
      customer: { name: "Lynda Davidson", email: "lynda@example.com", phone: "+61419005797" },
      shipping_address: {
        line1: "18-22 Jollytail Avenue", line2: null,
        city: "New Beith", postal_code: "4124", country: "Australia",
      },
      line_items: [
        { title: "Kookaburra in Pink No.2", variant: null, quantity: 1, unit_price: null, currency: "AUD" },
      ],
      shipping_cost: null,
      order_reference: "2382",
      notes: null,
      confidence: "high",
      ...overrides,
    },
  };
}

function failure(reason: "parse_error" | "validation_error" = "parse_error"): ExtractionResult {
  return {
    type: "failed",
    reason,
    errors: ["something went wrong"],
    rawText: "raw model output",
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("decideOutcome — happy path", () => {
  it("drafted: all required fields + confidence=high", () => {
    const d = decideOutcome(success());
    expect(d.outcome).toBe("drafted");
    expect(d.missingRequired).toHaveLength(0);
  });

  it("drafted outcome has no missingRequired entries", () => {
    const d = decideOutcome(success());
    expect(d.missingRequired).toEqual([]);
  });
});

describe("decideOutcome — needs_review", () => {
  it("confidence=medium → needs_review", () => {
    expect(decideOutcome(success({ confidence: "medium" })).outcome).toBe("needs_review");
  });

  it("confidence=low → needs_review", () => {
    expect(decideOutcome(success({ confidence: "low" })).outcome).toBe("needs_review");
  });

  it("needs_review has no missingRequired", () => {
    const d = decideOutcome(success({ confidence: "medium" }));
    expect(d.missingRequired).toHaveLength(0);
  });
});

describe("decideOutcome — failed (missing required fields)", () => {
  it("customer.name is null → failed", () => {
    const d = decideOutcome(success({ customer: { name: null, email: null, phone: null } }));
    expect(d.outcome).toBe("failed");
    expect(d.missingRequired).toContain("customer.name");
  });

  it("shipping_address.line1 is null → failed", () => {
    const d = decideOutcome(success({
      shipping_address: { line1: null, line2: null, city: "Sydney", postal_code: null, country: "Australia" },
    }));
    expect(d.outcome).toBe("failed");
    expect(d.missingRequired).toContain("shipping_address.line1");
  });

  it("shipping_address.city is null → failed", () => {
    const d = decideOutcome(success({
      shipping_address: { line1: "1 Main St", line2: null, city: null, postal_code: null, country: "Australia" },
    }));
    expect(d.outcome).toBe("failed");
    expect(d.missingRequired).toContain("shipping_address.city");
  });

  it("shipping_address.country is null → failed", () => {
    const d = decideOutcome(success({
      shipping_address: { line1: "1 Main St", line2: null, city: "Sydney", postal_code: null, country: null },
    }));
    expect(d.outcome).toBe("failed");
    expect(d.missingRequired).toContain("shipping_address.country");
  });

  it("multiple required fields missing → all listed in missingRequired", () => {
    const d = decideOutcome(success({
      customer: { name: null, email: null, phone: null },
      shipping_address: { line1: null, line2: null, city: null, postal_code: null, country: null },
    }));
    expect(d.outcome).toBe("failed");
    expect(d.missingRequired.length).toBeGreaterThanOrEqual(4);
  });
});

describe("decideOutcome — failed (extraction error)", () => {
  it("parse_error → failed", () => {
    expect(decideOutcome(failure("parse_error")).outcome).toBe("failed");
  });

  it("validation_error → failed", () => {
    expect(decideOutcome(failure("validation_error")).outcome).toBe("failed");
  });

  it("extraction failure has empty missingRequired", () => {
    expect(decideOutcome(failure()).missingRequired).toHaveLength(0);
  });
});

describe("decideOutcome — optional field tracking", () => {
  it("tracks missing customer.email in missingOptional", () => {
    const d = decideOutcome(success({
      customer: { name: "Test User", email: null, phone: null },
    }));
    expect(d.missingOptional).toContain("customer.email");
  });

  it("tracks missing customer.phone in missingOptional", () => {
    const d = decideOutcome(success({
      customer: { name: "Test User", email: "test@example.com", phone: null },
    }));
    expect(d.missingOptional).toContain("customer.phone");
  });

  it("flags all-null unit_price in missingOptional", () => {
    // Default success fixture has unit_price=null on the single item
    const d = decideOutcome(success());
    expect(d.missingOptional).toContain("line_items[*].unit_price (all null)");
  });

  it("does NOT flag unit_price when at least one item has a price", () => {
    const d = decideOutcome(success({
      line_items: [{ title: "Print", variant: null, quantity: 1, unit_price: 250, currency: "AUD" }],
    }));
    const priceFlag = d.missingOptional.find((s) => s.includes("unit_price"));
    expect(priceFlag).toBeUndefined();
  });

  it("missingOptional does not affect outcome when confidence=high", () => {
    // Even with several optional fields missing, high confidence + required fields = drafted
    const d = decideOutcome(success({
      customer: { name: "Test", email: null, phone: null },
      order_reference: null,
    }));
    expect(d.outcome).toBe("drafted");
  });
});
