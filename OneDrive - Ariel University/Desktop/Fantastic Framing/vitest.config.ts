import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Provide dummy values so config.ts doesn't call process.exit(1) in tests.
    // Tests that need specific config values mock the config module directly.
    env: {
      ANTHROPIC_API_KEY: "test-anthropic-key",
      SHOPIFY_SHOP_DOMAIN: "test.myshopify.com",
      SHOPIFY_ADMIN_API_TOKEN: "test-shopify-token",
      SENDGRID_INBOUND_TOKEN: "test-inbound-token",
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      REDIS_URL: "redis://localhost:6379",
      ADMIN_API_SECRET: "test-admin-secret",
      NODE_ENV: "test",
    },
  },
});
