import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma.js";
import { requireUser } from "../plugins/auth.js";
import { getProvider, primaryProviderName } from "../stt/registry.js";

/** Usage + analytics for the creator (session analytics, provider minutes). */
export function registerUsageRoutes(app: FastifyInstance): void {
  app.get("/v1/usage", async (req) => {
    const userId = requireUser(req);
    const db = prisma();
    const [sessionCount, totalSegments, viewerSessions, recordings] =
      await Promise.all([
        db.liveSession.count({
          where: { creatorUserId: userId, deletedAt: null },
        }),
        db.transcriptSegment.count({
          where: { liveSession: { creatorUserId: userId } },
        }),
        db.viewerSession.count({
          where: { liveSession: { creatorUserId: userId } },
        }),
        db.recording.aggregate({
          where: { liveSession: { creatorUserId: userId }, status: "stored" },
          _sum: { sizeBytes: true, durationMs: true },
        }),
      ]);
    const provider = getProvider(primaryProviderName());
    return {
      sessions: sessionCount,
      transcriptSegments: totalSegments,
      viewerSessions,
      recordingBytes: Number(recordings._sum.sizeBytes ?? 0),
      recordingDurationMs: recordings._sum.durationMs ?? 0,
      provider: provider?.usageMetadata() ?? null,
    };
  });

  app.get<{ Params: { id: string } }>(
    "/v1/sessions/:id/analytics",
    async (req) => {
      const userId = requireUser(req);
      const db = prisma();
      const session = await db.liveSession.findFirst({
        where: { id: req.params.id, creatorUserId: userId, deletedAt: null },
      });
      if (!session) {
        const { Errors } = await import("../lib/errors.js");
        throw Errors.notFound("Session");
      }
      const [viewers, peakStates, accessEvents, incidents] = await Promise.all([
        db.viewerSession.count({ where: { liveSessionId: session.id } }),
        db.viewerSession.groupBy({
          by: ["alignmentState"],
          where: { liveSessionId: session.id },
          _count: true,
        }),
        db.shareAccessEvent.groupBy({
          by: ["action"],
          where: { liveSessionId: session.id },
          _count: true,
        }),
        db.incidentEvent.findMany({
          where: { liveSessionId: session.id },
          orderBy: { startedAt: "desc" },
          take: 50,
          select: {
            component: true,
            severity: true,
            errorCode: true,
            message: true,
            startedAt: true,
            resolvedAt: true,
          },
        }),
      ]);
      return {
        totalViewerSessions: viewers,
        alignmentStates: Object.fromEntries(
          peakStates.map((s) => [s.alignmentState, s._count]),
        ),
        accessEvents: Object.fromEntries(
          accessEvents.map((a) => [a.action, a._count]),
        ),
        incidents,
      };
    },
  );
}
