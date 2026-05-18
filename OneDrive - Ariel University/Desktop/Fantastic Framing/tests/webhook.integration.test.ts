/**
 * Integration test: POST /webhooks/inbound-email
 *
 * Tests the full webhook handler — multipart parsing, token auth, dedup,
 * DB insert, and queue enqueue — with the DB and queue mocked so no real
 * infrastructure is required.
 *
 * For a test that exercises the worker too, run `npm run replay -- --id <id>`
 * against a live local stack (docker-compose up + npm run worker).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import multipart from "@fastify/multipart";

// ── Mocks (hoisted before any imports that touch these modules) ──────────────

// Drizzle mock — supports the chained select().from().where().limit() pattern
const mockLimit = vi.fn();
const mockWhere = vi.fn(() => ({ limit: mockLimit }));
const mockFrom = vi.fn(() => ({ where: mockWhere }));
const mockSelect = vi.fn(() => ({ from: mockFrom }));

const mockReturning = vi.fn();
const mockValues = vi.fn(() => ({ returning: mockReturning }));
const mockInsert = vi.fn(() => ({ values: mockValues }));

vi.mock("../src/db/index.js", () => ({
  db: {
    select: mockSelect,
    insert: mockInsert,
  },
}));

vi.mock("../src/db/schema.js", async (importOriginal) => {
  // Re-export schema types/values from the real module; we only mock db calls
  return importOriginal();
});

const mockQueueAdd = vi.fn();
vi.mock("../src/queue/index.js", () => ({
  emailQueue: { add: mockQueueAdd },
  getRedisOptions: vi.fn(() => ({})),
}));

vi.mock("../src/config.js", () => ({
  config: {
    SENDGRID_INBOUND_TOKEN: "test-token",
    ADMIN_API_SECRET: "admin-secret",
    PORT: 3000,
    NODE_ENV: "test",
    ANTHROPIC_API_KEY: "test-key",
    SHOPIFY_SHOP_DOMAIN: "test.myshopify.com",
    SHOPIFY_ADMIN_API_TOKEN: "test-shopify-token",
    DATABASE_URL: "postgresql://test",
    REDIS_URL: "redis://localhost:6379",
  },
}));

// ── Import under test (after mocks are registered) ───────────────────────────

const { webhookRoutes } = await import("../src/routes/webhook.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Builds a valid multipart/form-data body from a flat fields map. */
function buildMultipart(fields: Record<string, string>, boundary: string): Buffer {
  const parts = Object.entries(fields).map(
    ([name, value]) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}`,
  );
  return Buffer.from(parts.join("\r\n") + `\r\n--${boundary}--\r\n`);
}

const BOUNDARY = "TestBoundary1234567890";
const CONTENT_TYPE = `multipart/form-data; boundary=${BOUNDARY}`;

/** Minimal valid SendGrid Inbound Parse fields. */
const BASE_FIELDS = {
  from: "Haven Prints <hello@havenprints.com.au>",
  to: "framingordershavenprints@gmail.com",
  subject: "Haven Prints Order 2382",
  text: "Order #2382\nCustomer: Lynda Davidson",
  html: "",
  headers: "Message-ID: <haven-2382-test@mail.gmail.com>\r\nFrom: Haven Prints <hello@havenprints.com.au>",
  attachments: "0",
};

async function buildTestApp() {
  const app = Fastify({ logger: false });
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });
  await app.register(webhookRoutes);
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /webhooks/inbound-email", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no duplicate found
    mockLimit.mockResolvedValue([]);
    // Default: insert returns a new row id
    mockReturning.mockResolvedValue([{ id: 99 }]);
    // Default: queue add succeeds
    mockQueueAdd.mockResolvedValue(undefined);
  });

  it("returns 403 when token is missing", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/inbound-email", // no ?token=
      headers: { "content-type": CONTENT_TYPE },
      payload: buildMultipart(BASE_FIELDS, BOUNDARY),
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns 403 when token is wrong", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/inbound-email?token=wrong-token",
      headers: { "content-type": CONTENT_TYPE },
      payload: buildMultipart(BASE_FIELDS, BOUNDARY),
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns 200 queued on a new email", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/inbound-email?token=test-token",
      headers: { "content-type": CONTENT_TYPE },
      payload: buildMultipart(BASE_FIELDS, BOUNDARY),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "queued", id: 99 });
  });

  it("returns 200 duplicate (silently) when Message-ID already exists", async () => {
    // Simulate dedup hit: select returns a row with the same message-id
    mockLimit.mockResolvedValue([{ id: 1 }]);

    const app = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/inbound-email?token=test-token",
      headers: { "content-type": CONTENT_TYPE },
      payload: buildMultipart(BASE_FIELDS, BOUNDARY),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "duplicate" });
  });

  it("does not enqueue a job for a duplicate email", async () => {
    mockLimit.mockResolvedValue([{ id: 1 }]); // duplicate

    const app = await buildTestApp();
    await app.inject({
      method: "POST",
      url: "/webhooks/inbound-email?token=test-token",
      headers: { "content-type": CONTENT_TYPE },
      payload: buildMultipart(BASE_FIELDS, BOUNDARY),
    });
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("inserts the email with status=pending on success", async () => {
    const app = await buildTestApp();
    await app.inject({
      method: "POST",
      url: "/webhooks/inbound-email?token=test-token",
      headers: { "content-type": CONTENT_TYPE },
      payload: buildMultipart(BASE_FIELDS, BOUNDARY),
    });
    expect(mockInsert).toHaveBeenCalled();
    // The values() call should include status: "pending"
    const insertArg = mockValues.mock.calls[0][0] as Record<string, unknown>;
    expect(insertArg.status).toBe("pending");
  });

  it("enqueues exactly one job per new email", async () => {
    const app = await buildTestApp();
    await app.inject({
      method: "POST",
      url: "/webhooks/inbound-email?token=test-token",
      headers: { "content-type": CONTENT_TYPE },
      payload: buildMultipart(BASE_FIELDS, BOUNDARY),
    });
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd).toHaveBeenCalledWith("process-email", { emailId: 99 });
  });

  it("parses the sender address from the From field", async () => {
    const app = await buildTestApp();
    await app.inject({
      method: "POST",
      url: "/webhooks/inbound-email?token=test-token",
      headers: { "content-type": CONTENT_TYPE },
      payload: buildMultipart(BASE_FIELDS, BOUNDARY),
    });
    const insertArg = mockValues.mock.calls[0][0] as Record<string, unknown>;
    // Display name stripped — only the email address
    expect(insertArg.sender).toBe("hello@havenprints.com.au");
  });

  it("stores the subject from the form fields", async () => {
    const app = await buildTestApp();
    await app.inject({
      method: "POST",
      url: "/webhooks/inbound-email?token=test-token",
      headers: { "content-type": CONTENT_TYPE },
      payload: buildMultipart(BASE_FIELDS, BOUNDARY),
    });
    const insertArg = mockValues.mock.calls[0][0] as Record<string, unknown>;
    expect(insertArg.subject).toBe("Haven Prints Order 2382");
  });
});
