import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { prisma } from "../lib/prisma.js";
import { Errors } from "../lib/errors.js";
import { requireUser } from "../plugins/auth.js";
import { deleteObject, listKeys, presignGet, putObject } from "../lib/s3.js";
import { recordingChunksStored } from "../lib/metrics.js";
import { enqueueFinalizeRecording } from "../jobs/queue.js";
import { routeLimit } from "../lib/rateLimits.js";

/**
 * Recording pipeline: the browser MediaRecorder uploads sequential webm
 * chunks; each chunk is stored as its own object so an interrupted upload
 * loses at most one chunk. On finalize, a worker concatenates chunks into a
 * single object, verifies size/checksum, and marks the recording stored.
 */

const MAX_CHUNK_BYTES = 8 * 1024 * 1024;

async function ownedSession(sessionId: string, userId: string) {
  const session = await prisma().liveSession.findFirst({
    where: { id: sessionId, creatorUserId: userId, deletedAt: null },
  });
  if (!session) throw Errors.notFound("Session");
  return session;
}

export function registerRecordingRoutes(app: FastifyInstance): void {
  app.post<{ Params: { id: string } }>(
    "/v1/sessions/:id/recording/begin",
    async (req, reply) => {
      const userId = requireUser(req);
      const session = await ownedSession(req.params.id, userId);
      if (!session.recordingEnabled) {
        throw Errors.invalid("Recording is not enabled for this session.");
      }
      const db = prisma();
      const existing = await db.recording.findFirst({
        where: {
          liveSessionId: session.id,
          status: { in: ["recording", "uploading"] },
        },
      });
      if (existing)
        return { recordingId: existing.id, resumedChunks: existing.chunkCount };
      const rec = await db.recording.create({
        data: {
          liveSessionId: session.id,
          storageKey: `recordings/${session.id}/final.webm`,
          mimeType: "audio/webm",
          status: "recording",
        },
      });
      return reply.code(201).send({ recordingId: rec.id, resumedChunks: 0 });
    },
  );

  app.post<{
    Params: { id: string; recordingId: string };
    Querystring: { seq?: string };
  }>(
    "/v1/sessions/:id/recording/:recordingId/chunk",
    {
      config: { rateLimit: { max: routeLimit(600), timeWindow: "1 minute" } },
      bodyLimit: MAX_CHUNK_BYTES,
    },
    async (req) => {
      const userId = requireUser(req);
      const session = await ownedSession(req.params.id, userId);
      const db = prisma();
      const recording = await db.recording.findFirst({
        where: {
          id: req.params.recordingId,
          liveSessionId: session.id,
          status: "recording",
        },
      });
      if (!recording) throw Errors.notFound("Recording");
      const seq = parseInt(req.query.seq ?? "", 10);
      if (!Number.isInteger(seq) || seq < 0 || seq > 1_000_000) {
        throw Errors.invalid("Missing or invalid chunk sequence.");
      }
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        throw Errors.invalid("Empty chunk.");
      }
      const key = `recordings/${session.id}/chunks/${String(seq).padStart(8, "0")}.webm`;
      await putObject(key, body, "audio/webm");
      recordingChunksStored.inc();
      await db.recording.update({
        where: { id: recording.id },
        data: {
          chunkCount: { increment: 1 },
          sizeBytes: { increment: body.length },
        },
      });
      return { ok: true, seq };
    },
  );

  app.post<{ Params: { id: string; recordingId: string } }>(
    "/v1/sessions/:id/recording/:recordingId/finish",
    async (req) => {
      const userId = requireUser(req);
      const session = await ownedSession(req.params.id, userId);
      const body = (req.body ?? {}) as { durationMs?: number };
      const db = prisma();
      const recording = await db.recording.findFirst({
        where: {
          id: req.params.recordingId,
          liveSessionId: session.id,
          status: "recording",
        },
      });
      if (!recording) throw Errors.notFound("Recording");
      await db.recording.update({
        where: { id: recording.id },
        data: {
          status: "uploading",
          durationMs:
            typeof body.durationMs === "number" && body.durationMs > 0
              ? Math.round(body.durationMs)
              : 0,
        },
      });
      await enqueueFinalizeRecording(recording.id);
      return { ok: true, status: "uploading" };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/v1/sessions/:id/recording",
    async (req) => {
      const userId = requireUser(req);
      const session = await ownedSession(req.params.id, userId);
      const recording = await prisma().recording.findFirst({
        where: { liveSessionId: session.id, status: { not: "deleted" } },
        orderBy: { createdAt: "desc" },
      });
      if (!recording) throw Errors.notFound("Recording");
      const result: {
        id: string;
        status: string;
        durationMs: number;
        sizeBytes: number;
        checksum: string | null;
        url?: string;
      } = {
        id: recording.id,
        status: recording.status,
        durationMs: recording.durationMs,
        sizeBytes: Number(recording.sizeBytes),
        checksum: recording.checksum,
      };
      if (recording.status === "stored") {
        result.url = await presignGet(recording.storageKey, 600);
      }
      return result;
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/v1/sessions/:id/recording",
    async (req) => {
      const userId = requireUser(req);
      const session = await ownedSession(req.params.id, userId);
      const db = prisma();
      const recording = await db.recording.findFirst({
        where: { liveSessionId: session.id, status: { not: "deleted" } },
      });
      if (!recording) throw Errors.notFound("Recording");
      const chunkKeys = await listKeys(`recordings/${session.id}/`);
      for (const key of chunkKeys) await deleteObject(key);
      await db.recording.update({
        where: { id: recording.id },
        data: { status: "deleted", deletedAt: new Date() },
      });
      await db.auditEvent.create({
        data: {
          organizationId: session.organizationId,
          actorUserId: userId,
          action: "recording.delete",
          entityType: "recording",
          entityId: recording.id,
          requestId: req.id,
        },
      });
      return { ok: true };
    },
  );
}

/** Concatenate chunk objects into the final recording (worker-side). */
export async function finalizeRecording(recordingId: string): Promise<void> {
  const db = prisma();
  const recording = await db.recording.findUnique({
    where: { id: recordingId },
  });
  if (!recording || recording.status !== "uploading") return;
  const prefix = `recordings/${recording.liveSessionId}/chunks/`;
  const keys = await listKeys(prefix);
  if (keys.length === 0) {
    await db.recording.update({
      where: { id: recordingId },
      data: { status: "failed" },
    });
    return;
  }
  /**
   * Stream chunk objects into the final recording.
   *
   * Buffering every chunk and Buffer.concat-ing them held the whole recording
   * in memory twice — at the 180-minute session cap that is ~180 MB peak per
   * finalize, and concurrent finalizations would OOM the worker. Pulling one
   * chunk at a time through a stream keeps peak memory at one chunk plus one
   * 5 MiB multipart part, regardless of recording length.
   */
  const { getObjectBuffer, putObjectStream } = await import("../lib/s3.js");
  const hash = createHash("sha256");
  let sizeBytes = 0;

  /**
   * `Readable.from` pulls from the generator only as the consumer asks for
   * data, so backpressure is handled by the stream machinery. (A hand-rolled
   * push loop must not wait on "drain" — that is a Writable event a Readable
   * never emits, which deadlocks the moment a chunk exceeds the high-water
   * mark.) Chunks are fetched one at a time and hashed in flight, so peak
   * memory is one chunk plus one multipart part.
   */
  const source = Readable.from(
    (async function* () {
      for (const key of keys) {
        const buf = await getObjectBuffer(key);
        hash.update(buf);
        sizeBytes += buf.length;
        yield buf;
      }
    })(),
  );

  try {
    await putObjectStream(recording.storageKey, source, recording.mimeType);
  } catch (err) {
    // never leave a recording stuck in `uploading`: mark it failed so the
    // finalize job can be re-enqueued and the creator sees the real state
    await db.recording.update({
      where: { id: recordingId },
      data: { status: "failed" },
    });
    throw err;
  }

  const checksum = hash.digest("hex");
  await db.recording.update({
    where: { id: recordingId },
    data: { status: "stored", checksum, sizeBytes: BigInt(sizeBytes) },
  });
  const session = await db.liveSession.findUnique({
    where: { id: recording.liveSessionId },
    select: { status: true },
  });
  if (session?.status === "processing") {
    await db.liveSession.update({
      where: { id: recording.liveSessionId },
      data: { status: "completed" },
    });
  }
  const { publishToSession } = await import("../realtime/hub.js");
  await publishToSession(recording.liveSessionId, {
    type: "recording.status",
    session_id: recording.liveSessionId,
    status: "stored",
    duration_ms: recording.durationMs,
  });
}
