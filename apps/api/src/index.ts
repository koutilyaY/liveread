import { loadEnv } from "./env.js";
import { buildServer } from "./server.js";
import { ensureBucket } from "./lib/s3.js";
import { disconnectPrisma } from "./lib/prisma.js";
import { closeRedis } from "./lib/redis.js";
import { closeHub } from "./realtime/hub.js";
import { closeQueues } from "./jobs/queue.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await buildServer();
  await ensureBucket().catch((err) =>
    app.log.warn({ err }, "bucket_ensure_failed (storage may be starting)"),
  );
  await app.listen({ port: env.PORT, host: env.HOST });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await closeHub();
    await closeQueues();
    await closeRedis();
    await disconnectPrisma();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("fatal_startup_error", err);
  process.exit(1);
});
