#!/usr/bin/env tsx
/**
 * Replay script — run an email through the extraction pipeline locally.
 *
 * Invaluable for prompt tuning: load a real email from the DB (or a saved
 * fixture), call the live Anthropic API, and see the extraction + decision
 * results printed to stdout — without touching Shopify or updating any DB rows.
 *
 * Usage:
 *   npm run replay -- --id 42
 *   npm run replay -- --id 42 --save tests/fixtures/my-email.json
 *   npm run replay -- --file tests/fixtures/sendgrid-haven.json
 *
 * Options:
 *   --id   <n>      Load email by DB row id (requires DATABASE_URL in .env)
 *   --file <path>   Load a fixture JSON previously saved with --save
 *   --save <path>   After loading from DB, write the email row to a JSON file
 *                   so you can replay it offline without a DB connection
 */

import "dotenv/config";
import { readFileSync, writeFileSync } from "fs";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { emails, artistProfiles } from "../src/db/schema.js";
import { extractOrder, PROMPT_VERSION } from "../src/services/extraction.js";
import { decideOutcome } from "../src/services/decision.js";
import type { emails as EmailsTable } from "../src/db/schema.js";

type EmailRow = typeof EmailsTable.$inferSelect;

// ─── Arg parsing ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function arg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

const idArg   = arg("--id");
const fileArg = arg("--file");
const saveArg = arg("--save");

if (!idArg && !fileArg) {
  console.error(`
Usage:
  npm run replay -- --id <db-row-id>          Load from database
  npm run replay -- --file <fixture.json>      Load from saved fixture
  npm run replay -- --id <id> --save <path>    Load from DB and save fixture
`);
  process.exit(1);
}

// ─── Load email ───────────────────────────────────────────────────────────────

let email: EmailRow;

if (idArg) {
  const id = parseInt(idArg, 10);
  if (isNaN(id)) { console.error("--id must be a number"); process.exit(1); }

  let row: EmailRow | undefined;
  try {
    [row] = await db.select().from(emails).where(eq(emails.id, id)).limit(1);
  } catch (err) {
    console.error("Could not connect to the database. Is Docker running?\n", err);
    process.exit(1);
  }
  if (!row) { console.error(`Email ${id} not found in database`); process.exit(1); }
  email = row;

  if (saveArg) {
    writeFileSync(saveArg, JSON.stringify(email, null, 2));
    console.log(`Fixture saved → ${saveArg}\n`);
  }
} else {
  const raw = readFileSync(fileArg!, "utf-8");
  const parsed = JSON.parse(raw) as EmailRow;
  // JSON serialisation turns Date objects into strings; restore them
  email = {
    ...parsed,
    receivedAt: new Date(parsed.receivedAt),
    createdAt:  new Date(parsed.createdAt),
  };
}

// ─── Load / synthesise artist profile ────────────────────────────────────────

let artistRow: typeof artistProfiles.$inferSelect | undefined;
try {
  [artistRow] = await db
    .select()
    .from(artistProfiles)
    .where(eq(artistProfiles.email, email.sender))
    .limit(1);
} catch {
  // DB not reachable (e.g. Docker not running) — fall through to stub below.
}

// If the artist isn't in the DB yet (e.g. replaying from a fixture in CI),
// use a minimal stub so the prompt still has artist context.
const artist = artistRow ?? {
  id: 0,
  email: email.sender,
  name: email.sender,
  currency: "AUD",
  defaultShippingNotes: null,
  productNotes: null,
  active: false,
  createdAt: new Date(),
};

// ─── Print email summary ──────────────────────────────────────────────────────

const bar = "─".repeat(62);
console.log(`\n${bar}`);
console.log(`  Replaying email #${email.id}`);
console.log(bar);
console.log(`  From       : ${email.sender}`);
console.log(`  Subject    : ${email.subject ?? "(none)"}`);
console.log(`  Received   : ${email.receivedAt.toISOString()}`);
console.log(`  Body chars : ${email.rawBodyText?.length ?? 0}`);
if (email.attachments?.length) {
  const atts = email.attachments.map((a) => `${a.filename} (${a.mimeType})`).join(", ");
  console.log(`  Attachments: ${atts}`);
}
console.log(`  Artist     : ${artist.name} | currency=${artist.currency}${artist.productNotes ? ` | notes="${artist.productNotes}"` : ""}`);
console.log(`  Prompt ver : ${PROMPT_VERSION}`);
console.log(bar);
console.log(`\nCalling Claude… (this may take a few seconds)\n`);

// ─── Extract ──────────────────────────────────────────────────────────────────

const result = await extractOrder(email, artist);

if (result.type === "failed") {
  console.log(`\n✗  EXTRACTION FAILED  (${result.reason})\n`);
  result.errors.forEach((e) => console.log(`   • ${e}`));
  if (result.rawText) {
    console.log(`\n── Raw model response ${"─".repeat(40)}`);
    console.log(result.rawText);
  }
} else {
  console.log(`\n✓  EXTRACTION SUCCEEDED\n`);
  console.log(JSON.stringify(result.data, null, 2));
}

// ─── Decision ────────────────────────────────────────────────────────────────

const decision = decideOutcome(result);

console.log(`\n${bar}`);
console.log(`  Decision: ${decision.outcome.toUpperCase()}`);
if (decision.missingRequired.length > 0) {
  console.log(`  Missing required : ${decision.missingRequired.join(", ")}`);
}
if (decision.missingOptional.length > 0) {
  console.log(`  Missing optional : ${decision.missingOptional.join(", ")}`);
}
console.log(bar);
console.log();

process.exit(0);
