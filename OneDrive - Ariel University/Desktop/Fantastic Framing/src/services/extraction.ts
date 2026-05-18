import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { config } from "../config.js";
import type { emails, artistProfiles } from "../db/schema.js";

// Bump this string whenever the prompt changes so extraction_log stays queryable by version.
export const PROMPT_VERSION = "v1";

// ─── Zod schema ───────────────────────────────────────────────────────────────
//
// Mirrors the JSON shape Claude must return. Zod validates every field so
// the decision matrix (Step 5) can trust the types it receives.

export const ExtractionSchema = z.object({
  customer: z.object({
    name: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
  }),
  shipping_address: z.object({
    line1: z.string().nullable(),
    line2: z.string().nullable(),
    city: z.string().nullable(),
    postal_code: z.string().nullable(),
    country: z.string().nullable(),
  }),
  line_items: z
    .array(
      z.object({
        title: z.string().min(1),
        variant: z.string().nullable(),
        quantity: z.number().int().positive(),
        unit_price: z.number().nullable(),
        currency: z.string().nullable(),
      }),
    )
    .min(1, "At least one line item is required"),
  shipping_cost: z.number().nullable(),
  order_reference: z.string().nullable(),
  notes: z.string().nullable(),
  confidence: z.enum(["high", "medium", "low"]),
});

export type Extraction = z.infer<typeof ExtractionSchema>;

// ─── Result union ──────────────────────────────────────────────────────────────

export type ExtractionSuccess = { type: "success"; data: Extraction };

export type ExtractionFailure = {
  type: "failed";
  reason: "parse_error" | "validation_error";
  errors: string[];
  rawText: string;
};

export type ExtractionResult = ExtractionSuccess | ExtractionFailure;

// ─── Prompt ───────────────────────────────────────────────────────────────────
//
// Design notes from real artist emails:
//
// • Adele Naidoo   — cover-note body only ("see attached"), order data in PDF.
//                    Subject may contain order ref + customer name (#3791 - David James).
// • Laura Staniford — all in body, slash-delimited, no field labels.
//                    "SHIP + PACK" is a shipping note, NOT a line item.
//                    (Set artist_profiles.product_notes to remind Claude of this.)
// • Haven Prints   — labeled fields in body + PDF + JPG attachment.
// • Corinne Melanie — forwarded WooCommerce notification; has prices and free gift
//                    line items at $0.00 that must be kept, not filtered.
//
// The prompt is intentionally template-agnostic: Claude reads semantically.
// Artist-specific quirks go into artist_profiles.product_notes, not here.

const SYSTEM_PROMPT = `You are an order extraction assistant for Fantastic Framing, a picture framing company.
Artists email the company when they receive customer print/canvas/framing orders. Each artist uses a different
format: some write the details directly in the body, some attach a PDF order form, some forward automated
WooCommerce or Shopify order notifications. Extract the same structured fields regardless of format.

Return ONLY a JSON object wrapped in <extraction></extraction> tags. No explanation, no markdown, no code
fences — only the tags and the JSON inside them.

Schema:
{
  "customer": {
    "name": string|null,
    "email": string|null,
    "phone": string|null
  },
  "shipping_address": {
    "line1": string|null,
    "line2": string|null,
    "city": string|null,
    "postal_code": string|null,
    "country": string|null
  },
  "line_items": [
    {
      "title": string,
      "variant": string|null,
      "quantity": number,
      "unit_price": number|null,
      "currency": string|null
    }
  ],
  "shipping_cost": number|null,
  "order_reference": string|null,
  "notes": string|null,
  "confidence": "high"|"medium"|"low"
}

Extraction rules:
1. Use null for any field you cannot confidently identify. Never guess or infer values.
2. unit_price is often absent from these emails — null is the correct value, not a problem.
3. currency: if not stated in the email, use the artist's stated default currency.
4. line_items: include ALL items, including free gifts at $0.00. Do not filter anything out.
5. shipping_address.line2: use for unit/apartment numbers (e.g. "6/47 Dickenson St" →
   line1="47 Dickenson Street", line2="Unit 6").
6. order_reference: check the subject line first, then the body (e.g. #3791, Order 2382, Order #5744).
7. notes: capture special production instructions only (e.g. "edges same colour as print background").
   Exclude URLs, Google Drive links, file references, and payment information.
8. If the email body is sparse or just a cover note, the full order is likely in an attached PDF —
   read the attachment carefully before concluding any field is missing.
9. confidence levels:
   - "high"   — all required fields clearly present, no ambiguity
   - "medium" — required fields present but some parsing uncertainty (unusual address, ambiguous product)
   - "low"    — significant ambiguity, or one or more required fields are missing or unclear`;

// ─── Message builder ──────────────────────────────────────────────────────────

type EmailRow = typeof emails.$inferSelect;
type ArtistRow = typeof artistProfiles.$inferSelect;

export function buildUserMessage(email: EmailRow, artist: ArtistRow): Anthropic.MessageParam {
  const content: Anthropic.Messages.ContentBlockParam[] = [];

  // Artist context and email subject — always first so Claude has framing context
  const ctx: string[] = [
    `Artist: ${artist.name}`,
    `Default currency: ${artist.currency}`,
  ];
  if (artist.productNotes) ctx.push(`Artist product notes: ${artist.productNotes}`);
  if (artist.defaultShippingNotes) ctx.push(`Artist shipping notes: ${artist.defaultShippingNotes}`);
  if (email.subject) ctx.push("", `Subject: ${email.subject}`);

  content.push({ type: "text", text: ctx.join("\n") });

  // Email body
  if (email.rawBodyText?.trim()) {
    content.push({ type: "text", text: `Email body:\n${email.rawBodyText.trim()}` });
  }

  // Attachments — PDFs before images so the order data comes before the artwork photo
  const atts = email.attachments ?? [];
  const sorted = [
    ...atts.filter((a) => a.mimeType === "application/pdf"),
    ...atts.filter((a) => a.mimeType.startsWith("image/")),
  ];

  for (const att of sorted) {
    if (att.mimeType === "application/pdf") {
      // DocumentBlockParam — included in ContentBlockParam union in SDK ≥ 0.30
      content.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: att.data },
        title: att.filename,
      } as Anthropic.Messages.ContentBlockParam);
    } else if (
      att.mimeType === "image/jpeg" ||
      att.mimeType === "image/png" ||
      att.mimeType === "image/gif" ||
      att.mimeType === "image/webp"
    ) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: att.mimeType, data: att.data },
      });
    }
    // Other MIME types (TIFF, HEIC, XLSX…) skipped — Claude cannot read them
  }

  return { role: "user", content };
}

// ─── Anthropic client ─────────────────────────────────────────────────────────

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

// ─── Main extraction function ─────────────────────────────────────────────────

/**
 * Calls Claude to extract order data from an email + its attachments.
 *
 * Throws on Anthropic API/network errors  → BullMQ retries up to 3×.
 * Returns ExtractionFailure for bad output → worker handles without retrying.
 *
 * Prompt caching is applied to SYSTEM_PROMPT so repeated calls in the same
 * 5-minute window reuse the cached version (saves ~80 % of input token cost).
 */
export async function extractOrder(
  email: EmailRow,
  artist: ArtistRow,
): Promise<ExtractionResult> {
  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [buildUserMessage(email, artist)],
  });

  const responseText = message.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  // Pull out the JSON between <extraction> tags
  const match = responseText.match(/<extraction>([\s\S]*?)<\/extraction>/s);
  if (!match) {
    return {
      type: "failed",
      reason: "parse_error",
      errors: ["Response did not contain <extraction>…</extraction> tags"],
      rawText: responseText,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1].trim());
  } catch (e) {
    return {
      type: "failed",
      reason: "parse_error",
      errors: [`JSON.parse failed: ${e instanceof Error ? e.message : String(e)}`],
      rawText: responseText,
    };
  }

  const validated = ExtractionSchema.safeParse(parsed);
  if (!validated.success) {
    return {
      type: "failed",
      reason: "validation_error",
      errors: validated.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`),
      rawText: responseText,
    };
  }

  return { type: "success", data: validated.data };
}
