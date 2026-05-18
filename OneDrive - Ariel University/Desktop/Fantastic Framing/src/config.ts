import { z } from "zod";
import "dotenv/config";

const envSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1),
  SHOPIFY_SHOP_DOMAIN: z.string().min(1),
  SHOPIFY_ADMIN_API_TOKEN: z.string().min(1),
  SENDGRID_INBOUND_TOKEN: z.string().min(1),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  ADMIN_API_SECRET: z.string().min(1),
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
