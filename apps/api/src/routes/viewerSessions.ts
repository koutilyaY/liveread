import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { sha256 } from "../lib/crypto.js";
import { Errors } from "../lib/errors.js";
import { routeLimit } from "../lib/rateLimits.js";

/**
 * Viewer session state reporting. Only aggregate alignment POSITION is
 * stored (word index, sentence index, state, confidence) — never viewer
 * audio or recognized text.
 */
export function registerViewerSessionRoutes(app: FastifyInstance): void {
  app.patch<{ Params: { viewerSessionId: string } }>(
    "/v1/viewer-sessions/:viewerSessionId",
    { config: { rateLimit: { max: routeLimit(120), timeWindow: "1 minute" } } },
    async (req) => {
      const body = z
        .object({
          viewerToken: z.string().min(1).max(200),
          readAloudEnabled: z.boolean().optional(),
          currentWordIndex: z.number().int().min(-1).optional(),
          currentSentenceIndex: z.number().int().min(-1).optional(),
          alignmentState: z
            .enum(["waiting", "tracking", "uncertain", "lost", "caught_up"])
            .optional(),
          alignmentConfidence: z.number().min(0).max(1).optional(),
        })
        .parse(req.body);
      const db = prisma();
      const viewer = await db.viewerSession.findFirst({
        where: {
          id: req.params.viewerSessionId,
          tokenHash: sha256(body.viewerToken),
          endedAt: null,
        },
      });
      if (!viewer) throw Errors.unauthorized();
      const { viewerToken: _vt, ...update } = body;
      const data = Object.fromEntries(
        Object.entries(update).filter(([, v]) => v !== undefined),
      );
      await db.viewerSession.update({
        where: { id: viewer.id },
        data: { ...data, lastSeenAt: new Date() },
      });
      return { ok: true };
    },
  );

  app.post<{ Params: { viewerSessionId: string } }>(
    "/v1/viewer-sessions/:viewerSessionId/end",
    async (req) => {
      const body = z
        .object({ viewerToken: z.string().min(1).max(200) })
        .parse(req.body);
      const db = prisma();
      const viewer = await db.viewerSession.findFirst({
        where: {
          id: req.params.viewerSessionId,
          tokenHash: sha256(body.viewerToken),
        },
      });
      if (!viewer) throw Errors.unauthorized();
      await db.viewerSession.update({
        where: { id: viewer.id },
        data: { endedAt: new Date() },
      });
      return { ok: true };
    },
  );
}
