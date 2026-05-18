import type { FastifyPluginAsync } from "fastify";
import fastifyBasicAuth from "@fastify/basic-auth";
import { eq, desc } from "drizzle-orm";
import { db } from "../db/index.js";
import { emails, extractionLog, type EmailStatus } from "../db/schema.js";
import { shopifyDraftUrl } from "../services/shopify.js";
import { config } from "../config.js";

// ─── HTML helpers ─────────────────────────────────────────────────────────────

function h(str: string | null | undefined): string {
  return (str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const STATUS_STYLE: Record<EmailStatus, string> = {
  pending:      "background:#9e9e9e;color:#fff",
  extracted:    "background:#2196f3;color:#fff",
  needs_review: "background:#ff9800;color:#fff",
  drafted:      "background:#4caf50;color:#fff",
  failed:       "background:#f44336;color:#fff",
};

function badge(status: string): string {
  const style = STATUS_STYLE[status as EmailStatus] ?? "background:#ccc;color:#333";
  return `<span style="${style};padding:2px 10px;border-radius:12px;font-size:11px;font-weight:700;letter-spacing:.4px;text-transform:uppercase">${h(status)}</span>`;
}

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f2f5;color:#222}
.topbar{background:#16213e;color:#fff;padding:14px 28px;display:flex;align-items:center;gap:16px}
.topbar h1{font-size:18px;font-weight:600;flex:1}
.topbar a{color:#90caf9;font-size:13px;text-decoration:none}
.page{padding:24px 28px;max-width:1440px;margin:0 auto}
.filters{display:flex;gap:8px;margin-bottom:18px;flex-wrap:wrap}
.pill{padding:5px 14px;border-radius:20px;text-decoration:none;font-size:13px;background:#e0e0e0;color:#444}
.pill.on{background:#16213e;color:#fff}
.card{background:#fff;border-radius:10px;box-shadow:0 1px 4px rgba(0,0,0,.08);overflow:hidden;margin-bottom:24px}
.card-title{padding:14px 20px;font-size:14px;font-weight:600;color:#555;border-bottom:1px solid #f0f0f0;background:#fafafa}
table{width:100%;border-collapse:collapse}
th{padding:10px 16px;text-align:left;font-size:12px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.5px;background:#f7f7f7;border-bottom:1px solid #eee}
td{padding:11px 16px;border-top:1px solid #f3f3f3;font-size:13px;vertical-align:middle}
tr:hover td{background:#fafcff}
a.rlink{color:inherit;text-decoration:none;display:block}
.err{color:#c62828;font-size:12px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.empty{padding:60px;text-align:center;color:#aaa;font-size:14px}
pre{background:#1e1e2e;color:#cdd6f4;padding:16px 20px;border-radius:8px;overflow-x:auto;font-size:12.5px;line-height:1.6;tab-size:2}
.meta{display:grid;grid-template-columns:140px 1fr;gap:6px 14px;font-size:13px}
.meta .lbl{color:#888;font-weight:500}
.ecard{padding:20px}
.ecard+.ecard{border-top:1px solid #f0f0f0}
.sec-title{font-size:13px;font-weight:700;color:#555;text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px}
ul.verrs{list-style:none;display:flex;flex-direction:column;gap:6px}
ul.verrs li{padding:6px 12px;background:#fff3f3;border-left:3px solid #f44336;font-size:12.5px;font-family:monospace;border-radius:0 4px 4px 0}
.back{display:inline-flex;align-items:center;gap:6px;margin-bottom:20px;color:#16213e;text-decoration:none;font-size:13px;font-weight:500}
`;

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(title)} — Fantastic Framing</title>
<style>${CSS}</style>
</head>
<body>
<div class="topbar">
  <h1>Fantastic Framing — Order Emails</h1>
  <a href="/admin/emails">All emails</a>
</div>
<div class="page">${body}</div>
</body>
</html>`;
}

const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: "",            label: "All" },
  { value: "failed",      label: "Failed" },
  { value: "needs_review",label: "Needs Review" },
  { value: "drafted",     label: "Drafted" },
  { value: "extracted",   label: "Extracted" },
  { value: "pending",     label: "Pending" },
];

function filterNav(current: string | undefined): string {
  const pills = STATUS_FILTERS.map(({ value, label }) => {
    const href = value ? `/admin/emails?status=${value}` : "/admin/emails";
    const on = (current ?? "") === value ? " on" : "";
    return `<a class="pill${on}" href="${href}">${label}</a>`;
  }).join("");
  return `<div class="filters">${pills}</div>`;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export const adminRoutes: FastifyPluginAsync = async (app) => {
  // Basic auth — username: "admin", password: ADMIN_API_SECRET
  // All routes inside this plugin scope are protected.
  await app.register(fastifyBasicAuth, {
    validate: async (username: string, password: string) => {
      if (username !== "admin" || password !== config.ADMIN_API_SECRET) {
        return new Error("Unauthorized");
      }
    },
    authenticate: { realm: "Fantastic Framing Admin" },
  });

  // Protect every route registered in this scope
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.addHook("onRequest", (app as any).basicAuth);

  // ── List view ──────────────────────────────────────────────────────────────

  app.get<{ Querystring: { status?: string } }>("/admin/emails", async (req, reply) => {
    const statusFilter = req.query.status as EmailStatus | undefined;

    const rows = await db
      .select()
      .from(emails)
      .where(statusFilter ? eq(emails.status, statusFilter) : undefined)
      .orderBy(desc(emails.receivedAt))
      .limit(200);

    let tableHtml: string;
    if (rows.length === 0) {
      tableHtml = `<div class="empty">No emails found.</div>`;
    } else {
      const tbody = rows.map((r) => {
        const shopifyCell = r.shopifyDraftId
          ? `<a href="${h(shopifyDraftUrl(r.shopifyDraftId))}" target="_blank" rel="noopener" style="color:#1976d2">${h(r.shopifyDraftId)}</a>`
          : `<span style="color:#bbb">—</span>`;

        const when = r.receivedAt.toLocaleString("en-AU", {
          day: "2-digit", month: "short", year: "numeric",
          hour: "2-digit", minute: "2-digit",
        });

        return `<tr>
          <td><a class="rlink" href="/admin/emails/${r.id}">${h(when)}</a></td>
          <td><a class="rlink" href="/admin/emails/${r.id}">${h(r.sender)}</a></td>
          <td><a class="rlink" href="/admin/emails/${r.id}">${h(r.subject ?? "(no subject)")}</a></td>
          <td>${badge(r.status)}</td>
          <td>${shopifyCell}</td>
          <td class="err" title="${h(r.error ?? "")}">${h(r.error ?? "")}</td>
        </tr>`;
      }).join("");

      tableHtml = `<table>
        <thead><tr>
          <th>Received</th><th>From</th><th>Subject</th>
          <th>Status</th><th>Shopify Draft</th><th>Error</th>
        </tr></thead>
        <tbody>${tbody}</tbody>
      </table>`;
    }

    const countNote = `<p style="font-size:12px;color:#aaa;margin-bottom:12px">Showing up to 200 most recent${statusFilter ? ` · filtered: ${statusFilter}` : ""}</p>`;

    return reply.type("text/html").send(
      page("Emails", filterNav(statusFilter) + countNote + `<div class="card">${tableHtml}</div>`),
    );
  });

  // ── Detail view ────────────────────────────────────────────────────────────

  app.get<{ Params: { id: string } }>("/admin/emails/:id", async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return reply.status(400).send("Invalid ID");

    const [email] = await db.select().from(emails).where(eq(emails.id, id)).limit(1);
    if (!email) return reply.status(404).send("Email not found");

    // Latest extraction log entry (there may be multiple from retries)
    const [log] = await db
      .select()
      .from(extractionLog)
      .where(eq(extractionLog.emailId, id))
      .orderBy(desc(extractionLog.createdAt))
      .limit(1);

    const shopifyCell = email.shopifyDraftId
      ? `<a href="${h(shopifyDraftUrl(email.shopifyDraftId))}" target="_blank" style="color:#1976d2">${h(email.shopifyDraftId)} ↗</a>`
      : '<span style="color:#bbb">— (not yet created)</span>';

    const attCell = email.attachments?.length
      ? email.attachments.map((a) => h(`${a.filename} (${a.mimeType})`)).join("<br>")
      : '<span style="color:#bbb">none</span>';

    const metaCard = `
      <div class="card">
        <div class="card-title">Email #${id}</div>
        <div class="ecard">
          <div class="meta">
            <span class="lbl">From</span>       <span>${h(email.sender)}</span>
            <span class="lbl">Subject</span>    <span>${h(email.subject ?? "(none)")}</span>
            <span class="lbl">Received</span>   <span>${h(email.receivedAt.toISOString())}</span>
            <span class="lbl">Status</span>     <span>${badge(email.status)}</span>
            <span class="lbl">Shopify</span>    <span>${shopifyCell}</span>
            <span class="lbl">Attachments</span><span>${attCell}</span>
            ${email.error ? `<span class="lbl">Error</span><span style="color:#c62828">${h(email.error)}</span>` : ""}
          </div>
        </div>
      </div>`;

    const bodyCard = `
      <div class="card">
        <div class="card-title">Raw Email Body</div>
        <div class="ecard">
          <pre>${h(email.rawBodyText ?? "(no plain-text body)")}</pre>
        </div>
      </div>`;

    let extractCard: string;
    if (log) {
      const prettyJson = JSON.stringify(log.modelResponseJson, null, 2);
      const errSection = log.validationErrors?.length
        ? `<div class="ecard" style="border-top:1px solid #f0f0f0">
             <div class="sec-title">Validation errors</div>
             <ul class="verrs">${log.validationErrors.map((e) => `<li>${h(e)}</li>`).join("")}</ul>
           </div>`
        : "";

      extractCard = `
        <div class="card">
          <div class="card-title">Extraction — prompt_version: ${h(log.promptVersion)} · ${h(log.createdAt.toISOString())}</div>
          <div class="ecard"><pre>${h(prettyJson)}</pre></div>
          ${errSection}
        </div>`;
    } else {
      extractCard = `
        <div class="card">
          <div class="card-title">Extraction</div>
          <div class="ecard" style="color:#aaa;font-size:13px">No extraction log found — job may still be queued.</div>
        </div>`;
    }

    const body = `
      <a class="back" href="/admin/emails">← Back to list</a>
      ${metaCard}${bodyCard}${extractCard}`;

    return reply.type("text/html").send(page(`Email #${id}`, body));
  });
};
