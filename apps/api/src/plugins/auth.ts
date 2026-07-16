import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { prisma } from "../lib/prisma.js";
import { sha256 } from "../lib/crypto.js";
import { Errors } from "../lib/errors.js";

declare module "fastify" {
  interface FastifyRequest {
    userId: string | null;
    sessionTokenHash: string | null;
  }
}

export const SESSION_COOKIE = "liveread_session";

/**
 * Cookie session authentication. The cookie holds an opaque random token;
 * only its SHA-256 hash is stored. No tokens in localStorage, ever.
 */
export const authPlugin = fp(async (app: FastifyInstance) => {
  app.decorateRequest("userId", null);
  app.decorateRequest("sessionTokenHash", null);

  app.addHook("preHandler", async (req: FastifyRequest) => {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return;
    const tokenHash = sha256(token);
    const session = await prisma().authSession.findFirst({
      where: {
        tokenHash,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        user: { deletedAt: null },
      },
      select: { userId: true },
    });
    if (session) {
      req.userId = session.userId;
      req.sessionTokenHash = tokenHash;
    }
  });
});

export function requireUser(req: FastifyRequest): string {
  if (!req.userId) throw Errors.unauthorized();
  return req.userId;
}
