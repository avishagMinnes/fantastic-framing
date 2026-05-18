import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { config } from "./config.js";
import { webhookRoutes } from "./routes/webhook.js";
import { adminRoutes } from "./routes/admin.js";

const app = Fastify({ logger: true });

// 10 MB cap — large enough for order PDFs, tight enough to block abuse
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
