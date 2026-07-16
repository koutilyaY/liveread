import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireUser } from "../plugins/auth.js";
import { Errors } from "../lib/errors.js";
import { verifyPassword } from "../lib/crypto.js";
import { deleteObject, listKeys } from "../lib/s3.js";

/** Data export and account deletion (privacy requirements). */
export function registerPrivacyRoutes(app: FastifyInstance): void {
  app.get("/v1/privacy/export", async (req, reply) => {
    const userId = requireUser(req);
    const db = prisma();
    const user = await db.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        email: true,
        displayName: true,
        locale: true,
        timezone: true,
        createdAt: true,
      },
    });
    const sessions = await db.liveSession.findMany({
      where: { creatorUserId: userId, deletedAt: null },
      select: {
        id: true,
        title: true,
        languageCode: true,
        status: true,
        privacyMode: true,
        startedAt: true,
        endedAt: true,
        createdAt: true,
        segments: {
          where: { status: { in: ["final", "corrected"] } },
          orderBy: { segmentIndex: "asc" },
          select: { text: true, startMs: true, endMs: true, status: true },
        },
      },
    });
    reply.header(
      "Content-Disposition",
      'attachment; filename="liveread-export.json"',
    );
    return { exportedAt: new Date().toISOString(), user, sessions };
  });

  app.post("/v1/account/delete", async (req) => {
    const userId = requireUser(req);
    const { password } = z
      .object({ password: z.string().min(1) })
      .parse(req.body);
    const db = prisma();
    const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await verifyPassword(user.passwordHash, password))) {
      throw Errors.invalid("Incorrect password.");
    }
    const sessions = await db.liveSession.findMany({
      where: { creatorUserId: userId },
      select: { id: true },
    });
    for (const { id } of sessions) {
      const keys = await listKeys(`recordings/${id}/`);
      for (const key of keys) await deleteObject(key);
      await db.liveSession.delete({ where: { id } });
    }
    await db.authSession.updateMany({
      where: { userId },
      data: { revokedAt: new Date() },
    });
    // soft-delete user row for audit-trail integrity; PII is scrubbed
    await db.user.update({
      where: { id: userId },
      data: {
        deletedAt: new Date(),
        email: `deleted-${userId}@deleted.invalid`,
        displayName: "Deleted user",
        passwordHash: "deleted",
      },
    });
    return { ok: true };
  });
}
