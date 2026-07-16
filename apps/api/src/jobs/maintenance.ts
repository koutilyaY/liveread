import { prisma } from "../lib/prisma.js";
import { deleteObject, listKeys } from "../lib/s3.js";

/**
 * Retention cleanup: sessions whose retention window has elapsed since end
 * are hard-deleted (transcript + events + recording objects), per the
 * privacy requirements. Runs hourly from the worker.
 */
export async function retentionCleanup(): Promise<{ deleted: number }> {
  const db = prisma();
  const candidates = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM live_sessions
    WHERE ended_at IS NOT NULL
      AND deleted_at IS NULL
      AND ended_at + (retention_days || ' days')::interval < NOW()`;
  let deleted = 0;
  for (const { id } of candidates) {
    const keys = await listKeys(`recordings/${id}/`);
    for (const key of keys) await deleteObject(key);
    // hard delete: cascades to segments/events/revisions/viewer sessions
    await db.liveSession.delete({ where: { id } });
    deleted++;
  }
  return { deleted };
}

/**
 * Stale-session reconciliation: live/paused sessions with no creator
 * activity for 30+ minutes are ended so they don't hang forever.
 */
export async function reconcileStaleSessions(): Promise<{ ended: number }> {
  const db = prisma();
  const cutoff = new Date(Date.now() - 30 * 60 * 1000);
  const stale = await db.liveSession.findMany({
    where: {
      status: { in: ["live", "paused", "degraded"] },
      updatedAt: { lt: cutoff },
      audioStreams: { none: { status: "active" } },
    },
    select: { id: true },
  });
  for (const { id } of stale) {
    await db.liveSession.update({
      where: { id },
      data: { status: "completed", endedAt: new Date() },
    });
    await db.incidentEvent.create({
      data: {
        liveSessionId: id,
        component: "session_reconciler",
        severity: "info",
        errorCode: "stale_session_completed",
        message:
          "Session auto-completed after 30 minutes without creator activity.",
        recoverable: true,
        resolvedAt: new Date(),
      },
    });
  }
  return { ended: stale.length };
}

/** Orphaned uploads: chunk objects for recordings that no longer exist. */
export async function cleanupOrphanedUploads(): Promise<{ removed: number }> {
  const db = prisma();
  const keys = await listKeys("recordings/");
  let removed = 0;
  const sessionIds = new Set(
    (await db.liveSession.findMany({ select: { id: true } })).map((s) => s.id),
  );
  for (const key of keys) {
    const sessionId = key.split("/")[1];
    if (sessionId && !sessionIds.has(sessionId)) {
      await deleteObject(key);
      removed++;
    }
  }
  return { removed };
}
