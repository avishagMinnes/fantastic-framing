import { describe, it, expect } from "vitest";
import { buildUserMessage } from "../src/services/extraction.js";
import type { emails, artistProfiles } from "../src/db/schema.js";

// ─── Test fixtures ────────────────────────────────────────────────────────────

type EmailRow = typeof emails.$inferSelect;
type ArtistRow = typeof artistProfiles.$inferSelect;

const baseEmail: EmailRow = {
  id: 1,
  messageId: "<test@mail.gmail.com>",
  sender: "hello@havenprints.com.au",
  subject: "Haven Prints Order 2382",
  receivedAt: new Date("2026-05-05T06:44:00Z"),
  rawBodyText:
    "Order #2382\n1 x oak framed canvas print\n\nCustomer Details:\nLynda Davidson",
  rawBodyHtml: null,
  status: "pending",
  shopifyDraftId: null,
  error: null,
  attachments: null,
  createdAt: new Date("2026-05-05T06:44:00Z"),
};

const baseArtist: ArtistRow = {
  id: 1,
  email: "hello@havenprints.com.au",
  name: "Haven Prints",
  currency: "AUD",
  defaultShippingNotes: null,
  productNotes: null,
  active: true,
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

// Helper: collect all text block content from a message
function textBlocks(msg: ReturnType<typeof buildUserMessage>): string {
  return (msg.content as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

// Helper: get non-text blocks (documents + images)
function mediaBlocks(msg: ReturnType<typeof buildUserMessage>): Array<{ type: string }> {
  return (msg.content as Array<{ type: string }>).filter((b) => b.type !== "text");
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("buildUserMessage — message structure", () => {
  it("returns a user-role message", () => {
    const msg = buildUserMessage(baseEmail, baseArtist);
    expect(msg.role).toBe("user");
  });

  it("content is an array (never a bare string)", () => {
    const msg = buildUserMessage(baseEmail, baseArtist);
    expect(Array.isArray(msg.content)).toBe(true);
  });
});

describe("buildUserMessage — artist context injection", () => {
  it("includes artist name in context block", () => {
    expect(textBlocks(buildUserMessage(baseEmail, baseArtist))).toContain("Haven Prints");
  });

  it("includes artist currency", () => {
    expect(textBlocks(buildUserMessage(baseEmail, baseArtist))).toContain("AUD");
  });

  it("includes product notes when present", () => {
    const artist = {
      ...baseArtist,
      productNotes: "SHIP + PACK is a shipping note, not a line item.",
    };
    expect(textBlocks(buildUserMessage(baseEmail, artist))).toContain("SHIP + PACK");
  });

  it("includes shipping notes when present", () => {
    const artist = {
      ...baseArtist,
      defaultShippingNotes: "Always include packing slip.",
    };
    expect(textBlocks(buildUserMessage(baseEmail, artist))).toContain("packing slip");
  });

  it("omits product notes block when null", () => {
    const artist = { ...baseArtist, productNotes: null };
    // Should NOT contain a spurious "null" in the text
    expect(textBlocks(buildUserMessage(baseEmail, artist))).not.toContain("null");
  });
});

describe("buildUserMessage — subject line", () => {
  it("includes the email subject", () => {
    expect(textBlocks(buildUserMessage(baseEmail, baseArtist))).toContain("Haven Prints Order 2382");
  });

  it("omits subject block when subject is null", () => {
    const email = { ...baseEmail, subject: null };
    const text = textBlocks(buildUserMessage(email, baseArtist));
    expect(text).not.toContain("Subject:");
  });
});

describe("buildUserMessage — email body", () => {
  it("includes body text when present", () => {
    const text = textBlocks(buildUserMessage(baseEmail, baseArtist));
    expect(text).toContain("Lynda Davidson");
  });

  it("omits body block when rawBodyText is null", () => {
    const email = { ...baseEmail, rawBodyText: null };
    const msg = buildUserMessage(email, baseArtist);
    // Should have only 1 text block (context), no body block
    const blocks = (msg.content as Array<{ type: string; text?: string }>).filter(
      (b) => b.type === "text",
    );
    expect(blocks).toHaveLength(1);
  });

  it("omits body block when rawBodyText is empty string", () => {
    const email = { ...baseEmail, rawBodyText: "" };
    const blocks = (
      buildUserMessage(email, baseArtist).content as Array<{ type: string }>
    ).filter((b) => b.type === "text");
    expect(blocks).toHaveLength(1);
  });
});

describe("buildUserMessage — attachment ordering", () => {
  it("places PDF document block before image block", () => {
    const email: EmailRow = {
      ...baseEmail,
      rawBodyText: null,
      attachments: [
        { data: "imgdata", filename: "artwork.jpg",  mimeType: "image/jpeg" },
        { data: "pdfdata", filename: "order.pdf",    mimeType: "application/pdf" },
      ],
    };
    const media = mediaBlocks(buildUserMessage(email, baseArtist));
    expect(media).toHaveLength(2);
    expect(media[0].type).toBe("document"); // PDF first
    expect(media[1].type).toBe("image");    // image second
  });

  it("includes a document block for PDFs", () => {
    const email: EmailRow = {
      ...baseEmail,
      attachments: [{ data: "pdfdata", filename: "order.pdf", mimeType: "application/pdf" }],
    };
    const media = mediaBlocks(buildUserMessage(email, baseArtist));
    expect(media.some((b) => b.type === "document")).toBe(true);
  });

  it("includes an image block for JPEG attachments", () => {
    const email: EmailRow = {
      ...baseEmail,
      attachments: [{ data: "jpgdata", filename: "art.jpg", mimeType: "image/jpeg" }],
    };
    const media = mediaBlocks(buildUserMessage(email, baseArtist));
    expect(media.some((b) => b.type === "image")).toBe(true);
  });

  it("skips unsupported MIME types (TIFF, XLSX, etc.)", () => {
    const email: EmailRow = {
      ...baseEmail,
      attachments: [
        { data: "tiffdata", filename: "scan.tiff",  mimeType: "image/tiff" },
        { data: "xlsxdata", filename: "order.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      ],
    };
    const media = mediaBlocks(buildUserMessage(email, baseArtist));
    expect(media).toHaveLength(0);
  });

  it("handles null attachments (no attachment blocks)", () => {
    const email: EmailRow = { ...baseEmail, attachments: null };
    expect(mediaBlocks(buildUserMessage(email, baseArtist))).toHaveLength(0);
  });
});
