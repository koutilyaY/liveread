import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { Errors } from "../lib/errors.js";
import { requireUser } from "../plugins/auth.js";
import { correctSegment } from "../realtime/transcriptService.js";

async function ownedSession(sessionId: string, userId: string) {
  const session = await prisma().liveSession.findFirst({
    where: { id: sessionId, creatorUserId: userId, deletedAt: null },
  });
  if (!session) throw Errors.notFound("Session");
  return session;
}

export function registerTranscriptRoutes(app: FastifyInstance): void {
  /** Creator transcript view: all segments in order. */
  app.get<{ Params: { id: string } }>(
    "/v1/sessions/:id/transcript",
    async (req) => {
      const userId = requireUser(req);
      const session = await ownedSession(req.params.id, userId);
      const segments = await prisma().transcriptSegment.findMany({
        where: { liveSessionId: session.id },
        orderBy: { segmentIndex: "asc" },
        select: {
          id: true,
          segmentIndex: true,
          currentRevision: true,
          status: true,
          text: true,
          languageCode: true,
          startMs: true,
          endMs: true,
          confidence: true,
          finalizedAt: true,
          correctedAt: true,
        },
      });
      return { segments, lastSequence: session.lastSequence };
    },
  );

  /** Export transcript as plain text or WebVTT. */
  app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    "/v1/sessions/:id/transcript/export",
    async (req, reply) => {
      const userId = requireUser(req);
      const session = await ownedSession(req.params.id, userId);
      const segments = await prisma().transcriptSegment.findMany({
        where: {
          liveSessionId: session.id,
          status: { in: ["final", "corrected"] },
        },
        orderBy: { segmentIndex: "asc" },
      });
      const format = req.query.format ?? "txt";
      if (format === "vtt") {
        const ts = (ms: number) => {
          const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
          const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0");
          const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
          const f = String(ms % 1000).padStart(3, "0");
          return `${h}:${m}:${s}.${f}`;
        };
        const body =
          "WEBVTT\n\n" +
          segments
            .map(
              (seg, i) =>
                `${i + 1}\n${ts(seg.startMs)} --> ${ts(Math.max(seg.endMs, seg.startMs + 1000))}\n${seg.text}\n`,
            )
            .join("\n");
        reply.header("Content-Type", "text/vtt; charset=utf-8");
        reply.header(
          "Content-Disposition",
          `attachment; filename="transcript-${session.id}.vtt"`,
        );
        return reply.send(body);
      }
      reply.header("Content-Type", "text/plain; charset=utf-8");
      reply.header(
        "Content-Disposition",
        `attachment; filename="transcript-${session.id}.txt"`,
      );
      return reply.send(segments.map((s) => s.text).join("\n"));
    },
  );

  /** Creator correction with optimistic concurrency. */
  app.post<{ Params: { id: string; segmentId: string } }>(
    "/v1/sessions/:id/segments/:segmentId/correct",
    async (req) => {
      const userId = requireUser(req);
      const session = await ownedSession(req.params.id, userId);
      const body = z
        .object({
          text: z.string().min(1).max(5000),
          expectedRevision: z.number().int().nonnegative(),
          reason: z.string().max(500).optional(),
        })
        .parse(req.body);
      const result = await correctSegment({
        db: prisma(),
        sessionId: session.id,
        segmentId: req.params.segmentId,
        newText: body.text,
        expectedRevision: body.expectedRevision,
        actorUserId: userId,
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
      });
      if (!result.ok) {
        if (result.code === "revision_conflict") {
          throw Errors.conflict(
            "This segment was modified by someone else. Reload and try again.",
          );
        }
        if (result.code === "segment_not_finalized") {
          throw Errors.invalid("Only finalized segments can be corrected.");
        }
        throw Errors.notFound("Segment");
      }
      return { ok: true, event: result.event };
    },
  );

  /** Revision history for audit/inspection. */
  app.get<{ Params: { id: string; segmentId: string } }>(
    "/v1/sessions/:id/segments/:segmentId/revisions",
    async (req) => {
      const userId = requireUser(req);
      const session = await ownedSession(req.params.id, userId);
      const segment = await prisma().transcriptSegment.findFirst({
        where: { id: req.params.segmentId, liveSessionId: session.id },
      });
      if (!segment) throw Errors.notFound("Segment");
      const revisions = await prisma().transcriptRevision.findMany({
        where: { transcriptSegmentId: segment.id },
        orderBy: { revisionNumber: "asc" },
        select: {
          revisionNumber: true,
          source: true,
          previousText: true,
          newText: true,
          reason: true,
          createdAt: true,
          actor: { select: { displayName: true } },
        },
      });
      return {
        segmentId: segment.id,
        currentRevision: segment.currentRevision,
        revisions,
      };
    },
  );
}
