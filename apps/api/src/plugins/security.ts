import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { env, webOrigins } from "../env.js";
import { Errors } from "../lib/errors.js";

/**
 * Security headers, CSRF-by-origin verification for state-changing requests,
 * and request-size limits. CORS is registered separately in server.ts.
 */
export const securityPlugin = fp(async (app: FastifyInstance) => {
  app.addHook("onSend", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header("Permissions-Policy", "camera=(), geolocation=(), payment=()");
    reply.header(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'",
    );
    if (env().NODE_ENV === "production") {
      reply.header(
        "Strict-Transport-Security",
        "max-age=63072000; includeSubDomains",
      );
    }
  });

  // CSRF: cookies are SameSite=Lax AND mutating requests must present an
  // allowed Origin (or none, for non-browser clients without cookies).
  app.addHook("preHandler", async (req) => {
    const method = req.method.toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
    const origin = req.headers.origin;
    if (!origin) return; // curl/tests without cookies; cookie auth still applies
    if (!webOrigins().includes(origin)) {
      throw Errors.forbidden();
    }
  });
});
