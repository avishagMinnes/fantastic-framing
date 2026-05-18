import {
  pgTable,
  serial,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
} from "drizzle-orm/pg-core";

export type EmailStatus =
  | "pending"
  | "extracted"
  | "failed"
  | "needs_review"
  | "drafted";

export type EmailAttachment = {
  data: string;      // base64-encoded bytes
  filename: string;
  mimeType: string;
};

export const emails = pgTable("emails", {
  id: serial("id").primaryKey(),
  messageId: text("message_id").unique().notNull(),
  sender: text("sender").notNull(),
  subject: text("subject"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  rawBodyText: text("raw_body_text"),
  rawBodyHtml: text("raw_body_html"),
  status: text("status").$type<EmailStatus>().notNull().default("pending"),
  shopifyDraftId: text("shopify_draft_id"),
  error: text("error"),
  // All attachments from the email (PDF, JPG, etc.) stored as a JSONB array.
  // Some artists (e.g. Adele) attach PDFs; others (e.g. Haven) send PDF + JPG.
  attachments: jsonb("attachments").$type<EmailAttachment[]>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const artistProfiles = pgTable("artist_profiles", {
  id: serial("id").primaryKey(),
  email: text("email").unique().notNull(),
  name: text("name").notNull(),
  currency: text("currency").notNull().default("AUD"),
  defaultShippingNotes: text("default_shipping_notes"),
  productNotes: text("product_notes"),
  active: boolean("active").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const extractionLog = pgTable("extraction_log", {
  id: serial("id").primaryKey(),
  emailId: integer("email_id")
    .notNull()
    .references(() => emails.id),
  modelResponseJson: jsonb("model_response_json"),
  validationErrors: text("validation_errors").array(),
  promptVersion: text("prompt_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
