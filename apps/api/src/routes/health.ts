import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma.js";
import { redis } from "../lib/redis.js";
import { storageHealthy } from "../lib/s3.js";
import { registry } from "../lib/metrics.js";
import { providerHealthSummary } from "../stt/registry.js";

export function registerHealthRoutes(app: FastifyInstance): void {
  /** Liveness: process is up. */
  app.get("/healthz", async () => ({ ok: true, at: new Date().toISOString() }));

  /** Readiness: dependencies reachable. */
  app.get("/readyz", async (_req, reply) => {
    const checks: Record<string, boolean> = {};
    try {
      await prisma().$queryRaw`SELECT 1`;
      checks["database"] = true;
    } catch {
      checks["database"] = false;
    }
    try {
      checks["redis"] = (await redis().ping()) === "PONG";
    } catch {
      checks["redis"] = false;
    }
    checks["objectStorage"] = await storageHealthy();
    const ok = Object.values(checks).every(Boolean);
    return reply.code(ok ? 200 : 503).send({
      ok,
      checks,
      stt: providerHealthSummary(),
    });
  });

  app.get("/metrics", async (_req, reply) => {
    reply.header("Content-Type", registry.contentType);
    return reply.send(await registry.metrics());
  });
}
