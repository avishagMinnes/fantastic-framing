import { Queue } from "bullmq";
import type { RedisOptions } from "ioredis";
import { config } from "../config.js";

/**
 * Parses a Redis URL into IORedis connection options.
 * BullMQ recommends each class (Queue, Worker) creates its own connection,
 * so we export options rather than a shared IORedis instance.
 */
export function getRedisOptions(): RedisOptions {
  const u = new URL(config.REDIS_URL);
  const opts: RedisOptions = {
    host: u.hostname,
    port: u.port ? parseInt(u.port, 10) : 6379,
    maxRetriesPerRequest: null, // required by BullMQ
  };
  if (u.password) opts.password = decodeURIComponent(u.password);
  if (u.username && u.username !== "default") opts.username = decodeURIComponent(u.username);
  if (u.pathname && u.pathname !== "/") opts.db = parseInt(u.pathname.slice(1), 10);
  if (u.protocol === "rediss:") opts.tls = {}; // Render/Fly managed Redis uses TLS
  return opts;
}

export type EmailJobData = {
  emailId: number;
};

export const emailQueue = new Queue<EmailJobData>("email-processing", {
  connection: getRedisOptions(),
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 5_000, // 5s → 10s → 20s
    },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 200 },
  },
});
