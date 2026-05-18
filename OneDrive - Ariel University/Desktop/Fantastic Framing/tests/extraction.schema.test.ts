import { describe, it, expect } from "vitest";
import { ExtractionSchema } from "../src/services/extraction.js";

// A fully valid extraction — used as the base for negative tests.
const VALID = {
  customer: {
    name: "Lynda Davidson",
    email: "lyndadavidson783@gmail.com",
    phone: "+61419005797",
  },
  shipping_address: {
    line1: "18-22 Jollytail Avenue",
    line2: null,
    city: "New Beith",
    postal_code: "4124",
    country: "Australia",
  },
  line_items: [
    {
      title: "Kookaburra in Pink No.2",
      variant: "Oak 60cm×80cm",
      quantity: 1,
      unit_price: null,   // price absent — normal for these emails
      currency: "AUD",
    },
  ],
  shipping_cost: null,
  order_reference: "2382",
  notes: null,
  confidence: "high" as const,
};

describe("ExtractionSchema — valid inputs", () => {
  it("accepts a complete valid extraction", () => {
    expect(ExtractionSchema.safeParse(VALID).success).toBe(true);
  });

  it("accepts null for all optional fields", () => {
    const minimal = {
      customer: { name: "Test User", email: null, phone: null },
      shipping_address: {
        line1: "1 Test St", line2: null, city: "Sydney",
        postal_code: null, country: "Australia",
      },
      line_items: [
        { title: "Canvas Print", variant: null, quantity: 1, unit_price: null, currency: null },
      ],
      shipping_cost: null,
      order_reference: null,
      notes: null,
      confidence: "medium" as const,
    };
    expect(ExtractionSchema.safeParse(minimal).success).toBe(true);
  });

  it("accepts unit_price as a number", () => {
    const withPrice = {
      ...VALID,
      line_items: [{ ...VALID.line_items[0], unit_price: 2790.00, currency: "AUD" }],
    };
    expect(ExtractionSchema.safeParse(withPrice).success).toBe(true);
  });

  it("accepts multiple line items including $0 free gifts", () => {
    const withGifts = {
      ...VALID,
      line_items: [
        { title: "Paid Print", variant: null, quantity: 1, unit_price: 250, currency: "AUD" },
        { title: "Free Gift — Paros Fields", variant: "A1", quantity: 1, unit_price: 0, currency: "AUD" },
      ],
    };
    expect(ExtractionSchema.safeParse(withGifts).success).toBe(true);
  });

  it("accepts all three confidence values", () => {
    for (const confidence of ["high", "medium", "low"] as const) {
      expect(ExtractionSchema.safeParse({ ...VALID, confidence }).success).toBe(true);
    }
  });
});

describe("ExtractionSchema — invalid inputs", () => {
  it("rejects empty line_items array", () => {
    const r = ExtractionSchema.safeParse({ ...VALID, line_items: [] });
    expect(r.success).toBe(false);
  });

  it("rejects a line item with empty title", () => {
    const r = ExtractionSchema.safeParse({
      ...VALID,
      line_items: [{ ...VALID.line_items[0], title: "" }],
    });
    expect(r.success).toBe(false);
  });

  it("rejects negative quantity", () => {
    const r = ExtractionSchema.safeParse({
      ...VALID,
      line_items: [{ ...VALID.line_items[0], quantity: -1 }],
    });
    expect(r.success).toBe(false);
  });

  it("rejects zero quantity", () => {
    const r = ExtractionSchema.safeParse({
      ...VALID,
      line_items: [{ ...VALID.line_items[0], quantity: 0 }],
    });
    expect(r.success).toBe(false);
  });

  it("rejects fractional quantity", () => {
    const r = ExtractionSchema.safeParse({
      ...VALID,
      line_items: [{ ...VALID.line_items[0], quantity: 1.5 }],
    });
    expect(r.success).toBe(false);
  });

  it("rejects unknown confidence value", () => {
    const r = ExtractionSchema.safeParse({ ...VALID, confidence: "very_high" });
    expect(r.success).toBe(false);
  });

  it("rejects missing customer block", () => {
    const { customer: _, ...rest } = VALID;
    expect(ExtractionSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects missing shipping_address block", () => {
    const { shipping_address: _, ...rest } = VALID;
    expect(ExtractionSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects missing confidence field", () => {
    const { confidence: _, ...rest } = VALID;
    expect(ExtractionSchema.safeParse(rest).success).toBe(false);
  });
});
