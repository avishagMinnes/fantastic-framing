import type { FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { emails, type EmailAttachment } from "../db/schema.js";
import { emailQueue } from "../queue/index.js";
import { config } from "../config.js";

/**
 * Extracts Message-ID value from a raw email headers string.
 * SendGrid Inbound Parse delivers headers as a single multi-line string.
 * Falls back to a generated ID so dedup never crashes.
 */
function parseMessageId(rawHeaders: string): string | null {
  const match = rawHeaders.match(/^Message-ID:\s*<(.+?)>/im);
  return match ? match[1].trim() : null;
}

/**
 * Strips display name from "Name <email>" format.
 */
function extractEmailAddress(fromField: string): string {
  const match = fromField.match(/<([^>]+)>/);
  return match ? match[1].trim() : fromField.trim();
}

export const webhookRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Querystring: { token?: string } }>(
    "/webhooks/inbound-email",
    async (request, reply) => {
      // Token-based auth — SendGrid Inbound Parse URL-path token
      if (request.query.token !== config.SENDGRID_INBOUND_TOKEN) {
        return reply.status(403).send({ error: "Forbidden" });
      }

      // Parse multipart form-data sent by SendGrid Inbound Parse
      const fields: Record<string, string> = {};
      const attachments: EmailAttachment[] = [];

      const parts = request.parts();
      for await (const part of parts) {
        if (part.type === "field") {
          fields[part.fieldname] = part.value as string;
        } else {
          // SendGrid names files attachment1, attachment2, … — collect them all
          if (/^attachment\d+$/.test(part.fieldname)) {
            const buffer = await part.toBuffer();
            attachments.push({
              data: buffer.toString("base64"),
              filename: part.filename ?? "attachment",
              mimeType: part.mimetype ?? "application/octet-stream",
            });
          } else {
            await part.toBuffer(); // drain unrecognised parts to avoid hanging
          }
        }
      }

      const rawHeaders = fields["headers"] ?? "";
      const messageId =
        parseMessageId(rawHeaders) ??
        `generated-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      const sender = extractEmailAddress(fields["from"] ?? "unknown@unknown");
      const subject = fields["subject"] ?? null;
      const bodyText = fields["text"] ?? null;
      const bodyHtml = fields["html"] ?? null;

      // Deduplicate on Message-ID — SendGrid can deliver the same email twice
      const existing = await db
        .select({ id: emails.id })
        .from(emails)
        .where(eq(emails.messageId, messageId))
        .limit(1);

      if (existing.length > 0) {
        app.log.info({ messageId }, "duplicate email ignored");
        return reply.status(200).send({ status: "duplicate" });
      }

      // Persist email record immediately so the worker has everything it needs
      const [inserted] = await db
        .insert(emails)
        .values({
          messageId,
          sender,
          subject,
          receivedAt: new Date(),
          rawBodyText: bodyText,
          rawBodyHtml: bodyHtml,
          attachments: attachments.length > 0 ? attachments : null,
          status: "pending",
        })
        .returning({ id: emails.id });

      await emailQueue.add("process-email", { emailId: inserted.id });

      app.log.info({ messageId, emailId: inserted.id }, "email queued");
      return reply.status(200).send({ status: "queued", id: inserted.id });
    }
  );
};
