import "dotenv/config";
import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { emails, artistProfiles, extractionLog } from "./db/schema.js";
import { type EmailJobData, getRedisOptions } from "./queue/index.js";
import { extractOrder, PROMPT_VERSION } from "./services/extraction.js";
import { decideOutcome } from "./services/decision.js";
import { createShopifyDraft, shopifyDraftUrl } from "./services/shopify.js";

// ─── Artist profile helper ────────────────────────────────────────────────────

async function getOrCreateArtistProfile(sender: string) {
  const [existing] = await db
    .select()
    .from(artistProfiles)
    .where(eq(artistProfiles.email, sender))
    .limit(1);

  if (existing) return existing;

  const [stub] = await db
    .insert(artistProfiles)
    .values({
      email: sender,
      name: sender, // placeholder — fill in real name + activate in DB
      active: false,
    })
    .returning();

  console.log(`[worker] new artist stub: ${sender} (inactive — update name + activate in DB)`);
  return stub;
}

// ─── Main job processor ───────────────────────────────────────────────────────

async function processEmail(job: { data: EmailJobData }) {
  const { emailId } = job.data;

  // ── 1. Load email ──────────────────────────────────────────────────────────

  const [email] = await db
    .select()
    .from(emails)
    .where(eq(emails.id, emailId))
    .limit(1);

  if (!email) {
    throw new Error(`Email ${emailId} not found in database`);
  }

  // Guard: if a previous attempt already created the Shopify draft, skip.
  // This prevents double-draft creation when BullMQ retries after a late failure.
  if (email.shopifyDraftId) {
    console.log(`[worker] email ${emailId} already drafted (${email.shopifyDraftId}) — skipping`);
    return;
  }

  // ── 2. Artist profile ──────────────────────────────────────────────────────

  const artist = await getOrCreateArtistProfile(email.sender);

  const attSummary =
    email.attachments?.map((a) => `${a.filename} (${a.mimeType})`).join(", ") ?? "none";

  console.log("─".repeat(60));
  console.log(`[worker] email_id    : ${email.id}`);
  console.log(`[worker] from        : ${email.sender}`);
  console.log(`[worker] subject     : ${email.subject ?? "(none)"}`);
  console.log(`[worker] body_chars  : ${email.rawBodyText?.length ?? 0}`);
  console.log(`[worker] attachments : ${attSummary}`);
  console.log(`[worker] artist      : ${artist.name} | active=${artist.active} | currency=${artist.currency}`);

  // ── 3. Extract ────────────────────────────────────────────────────────────
  //
  // Throws on Anthropic API / network errors → BullMQ retries (3× exponential).
  // Returns ExtractionFailure for bad model output → handled below, no retry needed.

  const result = await extractOrder(email, artist);

  // ── 4. Persist extraction log ─────────────────────────────────────────────

  await db.insert(extractionLog).values({
    emailId: email.id,
    modelResponseJson:
      result.type === "success"
        ? (result.data as unknown as Record<string, unknown>)
        : { reason: result.reason, errors: result.errors, rawText: result.rawText },
    validationErrors: result.type === "failed" ? result.errors : null,
    promptVersion: PROMPT_VERSION,
  });

  if (result.type === "success") {
    const { data } = result;
    console.log(`[worker] extracted ✓  confidence=${data.confidence}`);
    console.log(`[worker] customer    : ${data.customer.name ?? "?"} <${data.customer.email ?? "—"}>`);
    console.log(
      `[worker] address     : ${data.shipping_address.line1 ?? "?"}, ` +
        `${data.shipping_address.city ?? "?"}, ${data.shipping_address.country ?? "?"}`,
    );
    console.log(
      `[worker] items (${data.line_items.length})  : ` +
        data.line_items.map((i) => `${i.quantity}× ${i.title}`).join(" | "),
    );
    console.log(`[worker] order_ref   : ${data.order_reference ?? "(none)"}`);
  } else {
    console.log(`[worker] extraction ✗  ${result.reason}: ${result.errors.join("; ")}`);
  }

  // ── 5. Decision matrix ────────────────────────────────────────────────────

  const decision = decideOutcome(result);

  console.log(`[worker] decision    : ${decision.outcome}`);
  if (decision.missingRequired.length > 0) {
    console.log(`[worker] missing req : ${decision.missingRequired.join(", ")}`);
  }
  if (decision.missingOptional.length > 0) {
    console.log(`[worker] missing opt : ${decision.missingOptional.join(", ")}`);
  }

  // ── 6. Shopify draft ──────────────────────────────────────────────────────
  //
  // Every outcome creates a draft — drafted, needs_review, and failed all land
  // in Shopify so the team can triage from the Drafts view and get push alerts
  // via Shopify's built-in "new draft order" staff notification.
  //
  // If Shopify itself fails (5xx, bad token), the catch block sets status=failed
  // and re-throws so BullMQ can retry. After all retries are exhausted the email
  // surfaces on the /admin/emails page with shopify_draft_id=null.

  let shopifyDraftId: string;

  try {
    shopifyDraftId = await createShopifyDraft(email, artist.name, result, decision);
  } catch (err) {
    const errMsg = `Shopify creation failed: ${err instanceof Error ? err.message : String(err)}`;
    await db
      .update(emails)
      .set({ status: "failed", error: errMsg })
      .where(eq(emails.id, email.id));
    console.error(`[worker] Shopify ✗  ${errMsg}`);
    throw err; // Re-throw → BullMQ retries (if attempts remain)
  }

  // ── 7. Finalise ───────────────────────────────────────────────────────────

  const errorMsg =
    decision.outcome === "failed"
      ? result.type === "failed"
        ? `${result.reason}: ${result.errors.join("; ")}`
        : `Required fields missing: ${decision.missingRequired.join(", ")}`
      : null;

  await db
    .update(emails)
    .set({
      status: decision.outcome,
      shopifyDraftId,
      error: errorMsg,
    })
    .where(eq(emails.id, email.id));

  console.log(`[worker] Shopify ✓   draft ${shopifyDraftId}`);
  console.log(`[worker] url         : ${shopifyDraftUrl(shopifyDraftId)}`);
  console.log(`[worker] status → ${decision.outcome}`);
  console.log("─".repeat(60));
}

// ─── Worker setup ─────────────────────────────────────────────────────────────

const worker = new Worker<EmailJobData>("email-processing", processEmail, {
  connection: getRedisOptions(),
  concurrency: 3,
});

worker.on("completed", (job) => {
  console.log(`[worker] ✓ job ${job.id} (email ${job.data.emailId}) completed`);
});

worker.on("failed", (job, err) => {
  console.error(`[worker] ✗ job ${job?.id} (email ${job?.data.emailId}) exhausted retries: ${err.message}`);
});

worker.on("error", (err) => {
  console.error("[worker] worker error:", err);
});

async function shutdown() {
  console.log("[worker] shutting down…");
  await worker.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

console.log("[worker] started, waiting for jobs…");
