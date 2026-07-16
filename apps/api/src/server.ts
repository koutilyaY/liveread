import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { env, trustProxyConfig, webOrigins } from "./env.js";
import { ApiError } from "./lib/errors.js";
import { httpRequestDuration } from "./lib/metrics.js";
import { authPlugin } from "./plugins/auth.js";
import { securityPlugin } from "./plugins/security.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerShareRoutes } from "./routes/share.js";
import { registerTranscriptRoutes } from "./routes/transcript.js";
import { registerRecordingRoutes } from "./routes/recordings.js";
import { registerViewerSessionRoutes } from "./routes/viewerSessions.js";
import { registerUsageRoutes } from "./routes/usage.js";
import { registerPrivacyRoutes } from "./routes/privacy.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerCreatorSocket } from "./realtime/creatorSocket.js";
import { registerViewerSocket } from "./realtime/viewerSocket.js";
import { redis } from "./lib/redis.js";

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env().LOG_LEVEL,
      redact: {
        paths: [
          "req.headers.cookie",
          "req.headers.authorization",
          "*.password",
          "*.token",
          "*.shareToken",
          "*.viewerToken",
        ],
        censor: "[redacted]",
      },
    },
    genReqId: () => randomUUID(),
    bodyLimit: 1024 * 1024, // JSON bodies; recording chunks override per-route
    // default false: forged X-Forwarded-For must not mint fresh rate-limit
    // buckets. Configure TRUST_PROXY with the real LB addresses in production.
    trustProxy: trustProxyConfig(),
  });

  // raw binary bodies for recording chunk uploads
  app.addContentTypeParser(
    ["audio/webm", "application/octet-stream", "video/webm"],
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );

  await app.register(cookie, { secret: env().COOKIE_SECRET });
  await app.register(cors, {
    origin: webOrigins(),
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
  });
  await app.register(rateLimit, {
    global: true,
    max: env().NODE_ENV === "production" ? 300 : 30000,
    timeWindow: "1 minute",
    redis: redis(),
    nameSpace: "rl:",
    addHeaders: {
      "x-ratelimit-limit": true,
      "x-ratelimit-remaining": true,
      "x-ratelimit-reset": true,
    },
  });
  await app.register(websocket, {
    options: { maxPayload: 1024 * 1024 },
  });
  await app.register(swagger, {
    openapi: {
      info: {
        title: "LiveRead API",
        version: "1.0.0",
        description:
          "Real-time voice-to-text publishing and synchronized read-aloud platform.",
      },
      servers: [{ url: "/" }],
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  await app.register(securityPlugin);
  await app.register(authPlugin);

  app.addHook("onResponse", async (req, reply) => {
    httpRequestDuration.observe(
      {
        method: req.method,
        route: req.routeOptions.url ?? "unknown",
        status: String(reply.statusCode),
      },
      reply.elapsedTime / 1000,
    );
  });

  app.setErrorHandler((err, req, reply) => {
    const correlationId = req.id;
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send({
        error: {
          code: err.code,
          message: err.message,
          details: err.details ?? null,
        },
        correlationId,
      });
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: "validation_error",
          message: "Request validation failed.",
          details: err.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        },
        correlationId,
      });
    }
    const fe = err as {
      statusCode?: unknown;
      code?: unknown;
      message?: unknown;
    };
    if (typeof fe.statusCode === "number" && fe.statusCode < 500) {
      return reply.code(fe.statusCode).send({
        error: {
          code: typeof fe.code === "string" ? fe.code : "request_error",
          message:
            typeof fe.message === "string" ? fe.message : "Request failed.",
          details: null,
        },
        correlationId,
      });
    }
    req.log.error({ err }, "unhandled_error");
    return reply.code(500).send({
      error: {
        code: "internal_error",
        message: "Something went wrong. Share the correlation ID with support.",
        details: null,
      },
      correlationId,
    });
  });

  registerHealthRoutes(app);
  registerAuthRoutes(app);
  registerSessionRoutes(app);
  registerShareRoutes(app);
  registerTranscriptRoutes(app);
  registerRecordingRoutes(app);
  registerViewerSessionRoutes(app);
  registerUsageRoutes(app);
  registerPrivacyRoutes(app);
  registerCreatorSocket(app);
  registerViewerSocket(app);

  return app;
}
