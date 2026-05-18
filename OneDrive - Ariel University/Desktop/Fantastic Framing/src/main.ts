/**
 * Combined entry point for production — starts both the Fastify web server
 * and the BullMQ worker in the same process so Railway only needs one service.
 */

import "dotenv/config";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { config } from "./config.js";
import { webhookRoutes } from "./routes/webhook.js";
import { adminRoutes } from "./routes/admin.js";
import { db } from "./db/index.js";
import { emails, artistProfiles, extractionLog } from "./db/schema.js";
import { type EmailJobData, getRedisOptions } from "./queue/index.js";
import { extractOrder, PROMPT_VERSION } from "./services/extraction.js";
import { decideOutcome } from "./services/decision.js";
import { createShopifyDraft, shopifyDraftUrl } from "./services/shopify.js";

// ─── Worker ───────────────────────────────────────────────────────────────────

async function getOrCreateArtistProfile(sender: string) {
  const [existing] = await db
    .select()
    .from(artistProfiles)
    .where(eq(artistProfiles.email, sender))
    .limit(1);

  if (existing) return existing;

  const [stub] = await db
    .insert(artistProfiles)
    .values({ email: sender, name: sender, active: false })
    .returning();

  console.log(`[worker] new artist stub: ${sender} (inactive — update name + activate in DB)`);
  return stub;
}

async function processEmail(job: { data: EmailJobData }) {
  const { emailId } = job.data;

  const [email] = await db
    .select()
    .from(emails)
    .where(eq(emails.id, emailId))
    .limit(1);

  if (!email) throw new Error(`Email ${emailId} not found`);

  if (email.shopifyDraftId) {
    console.log(`[worker] email ${emailId} already drafted — skipping`);
    return;
  }

  const artist = await getOrCreateArtistProfile(email.sender);

  console.log("─".repeat(60));
  console.log(`[worker] email_id : ${email.id} | from: ${email.sender}`);
  console.log(`[worker] artist   : ${artist.name} | active=${artist.active}`);

  const result = await extractOrder(email, artist);

  await db.insert(extractionLog).values({
    emailId: email.id,
    modelResponseJson:
      result.type === "success"
        ? (result.data as unknown as Record<string, unknown>)
        : { reason: result.reason, errors: result.errors },
    validationErrors: result.type === "failed" ? result.errors : null,
    promptVersion: PROMPT_VERSION,
  });

  const decision = decideOutcome(result);
  console.log(`[worker] decision : ${decision.outcome}`);

  let shopifyDraftId: string;
  try {
    shopifyDraftId = await createShopifyDraft(email, artist.name, result, decision);
  } catch (err) {
    const errMsg = `Shopify creation failed: ${err instanceof Error ? err.message : String(err)}`;
    await db.update(emails).set({ status: "failed", error: errMsg }).where(eq(emails.id, email.id));
    console.error(`[worker] Shopify ✗  ${errMsg}`);
    throw err;
  }

  const errorMsg =
    decision.outcome === "failed"
      ? result.type === "failed"
        ? `${result.reason}: ${result.errors.join("; ")}`
        : `Required fields missing: ${decision.missingRequired.join(", ")}`
      : null;

  await db
    .update(emails)
    .set({ status: decision.outcome, shopifyDraftId, error: errorMsg })
    .where(eq(emails.id, email.id));

  console.log(`[worker] Shopify ✓ draft ${shopifyDraftId}`);
  console.log(`[worker] url      : ${shopifyDraftUrl(shopifyDraftId)}`);
  console.log("─".repeat(60));
}

const worker = new Worker<EmailJobData>("email-processing", processEmail, {
  connection: getRedisOptions(),
  concurrency: 3,
});

worker.on("failed", (job, err) => {
  console.error(`[worker] ✗ job ${job?.id} failed: ${err.message}`);
});

console.log("[worker] started");

// ─── Server ───────────────────────────────────────────────────────────────────

const app = Fastify({ logger: true });

await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });

app.get("/healthz", async () => ({ status: "ok" }));

await app.register(webhookRoutes);
await app.register(adminRoutes);

try {
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// ─── Shutdown ─────────────────────────────────────────────────────────────────

async function shutdown() {
  console.log("shutting down…");
  await worker.close();
  await app.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
