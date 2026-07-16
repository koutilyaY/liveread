import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { PRIVACY_MODES } from "@liveread/shared";
import { prisma } from "../lib/prisma.js";
import { hashPassword, randomToken, sha256 } from "../lib/crypto.js";
import { Errors } from "../lib/errors.js";
import { env } from "../env.js";
import { requireUser } from "../plugins/auth.js";
import {
  beginEndingSession,
  completeSession,
  pauseSession,
  resumeSession,
  startSession,
} from "../realtime/sessionControl.js";
import { redis } from "../lib/redis.js";
import { storageHealthy } from "../lib/s3.js";
import { getProvider, primaryProviderName } from "../stt/registry.js";
import { disconnectViewers, viewerCount } from "../realtime/hub.js";

const CreateSessionSchema = z.object({
  title: z.string().min(1).max(200),
  languageCode: z.string().min(2).max(20).default("en-US"),
  privacyMode: z.enum(PRIVACY_MODES).default("unlisted"),
  passcode: z.string().min(4).max(100).optional(),
  creatorAudioEnabled: z.boolean().default(false),
  recordingEnabled: z.boolean().default(true),
  interimReadingEnabled: z.boolean().default(false),
  retentionDays: z.number().int().min(1).max(3650).default(90),
  shareExpiresInHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 365)
    .optional(),
  vocabulary: z
    .array(
      z.object({
        phrase: z.string().min(1).max(100),
        pronunciationHint: z.string().max(200).optional(),
        boost: z.number().min(0).max(10).default(1),
      }),
    )
    .max(100)
    .default([]),
});

async function ownedSession(sessionId: string, userId: string) {
  const session = await prisma().liveSession.findFirst({
    where: { id: sessionId, creatorUserId: userId, deletedAt: null },
  });
  if (!session) throw Errors.notFound("Session");
  return session;
}

function sessionView(s: {
  id: string;
  title: string;
  languageCode: string;
  status: string;
  privacyMode: string;
  shareId: string;
  creatorAudioEnabled: boolean;
  recordingEnabled: boolean;
  interimReadingEnabled: boolean;
  retentionDays: number;
  lastSequence: number;
  startedAt: Date | null;
  endedAt: Date | null;
  shareExpiresAt: Date | null;
  shareRevokedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: s.id,
    title: s.title,
    languageCode: s.languageCode,
    status: s.status,
    privacyMode: s.privacyMode,
    shareId: s.shareId,
    creatorAudioEnabled: s.creatorAudioEnabled,
    recordingEnabled: s.recordingEnabled,
    interimReadingEnabled: s.interimReadingEnabled,
    retentionDays: s.retentionDays,
    lastSequence: s.lastSequence,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    shareExpiresAt: s.shareExpiresAt,
    shareRevoked: s.shareRevokedAt !== null,
    createdAt: s.createdAt,
  };
}

export function registerSessionRoutes(app: FastifyInstance): void {
  app.post("/v1/sessions", async (req, reply) => {
    const userId = requireUser(req);
    const body = CreateSessionSchema.parse(req.body);
    const db = prisma();

    const user = await db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { emailVerifiedAt: true },
    });
    if (!user.emailVerifiedAt) {
      throw Errors.forbidden();
    }

    const activeCount = await db.liveSession.count({
      where: {
        creatorUserId: userId,
        status: { in: ["preflight", "live", "paused", "degraded"] },
        deletedAt: null,
      },
    });
    if (activeCount >= env().MAX_CONCURRENT_SESSIONS_PER_USER) {
      throw Errors.tooMany(
        `You already have ${activeCount} active sessions. End one before starting another.`,
      );
    }

    const membership = await db.organizationMembership.findFirst({
      where: { userId },
      orderBy: { createdAt: "asc" },
    });
    if (!membership) throw Errors.forbidden();

    const org = await db.organization.findUniqueOrThrow({
      where: { id: membership.organizationId },
      select: { publicLinksAllowed: true },
    });
    if (
      !org.publicLinksAllowed &&
      (body.privacyMode === "public" || body.privacyMode === "unlisted")
    ) {
      throw Errors.invalid(
        "Your organization does not allow public share links.",
      );
    }

    const shareToken = randomToken(24);
    const shareId = randomToken(12);
    const session = await db.liveSession.create({
      data: {
        organizationId: membership.organizationId,
        creatorUserId: userId,
        title: body.title,
        languageCode: body.languageCode,
        privacyMode: body.privacyMode,
        shareId,
        shareTokenHash: sha256(shareToken),
        sharePasscodeHash: body.passcode
          ? await hashPassword(body.passcode)
          : null,
        shareExpiresAt: body.shareExpiresInHours
          ? new Date(Date.now() + body.shareExpiresInHours * 3600_000)
          : null,
        creatorAudioEnabled: body.creatorAudioEnabled,
        recordingEnabled: body.recordingEnabled,
        interimReadingEnabled: body.interimReadingEnabled,
        retentionDays: body.retentionDays,
        transcriptionProvider: primaryProviderName(),
        vocabulary: {
          create: body.vocabulary.map((v) => ({
            phrase: v.phrase,
            pronunciationHint: v.pronunciationHint ?? null,
            boost: v.boost,
          })),
        },
      },
    });
    await db.auditEvent.create({
      data: {
        organizationId: membership.organizationId,
        actorUserId: userId,
        action: "session.create",
        entityType: "live_session",
        entityId: session.id,
        requestId: req.id,
        afterState: { title: body.title, privacyMode: body.privacyMode },
      },
    });
    return reply.code(201).send({
      ...sessionView(session),
      // plaintext share token returned exactly once at creation
      shareToken,
      viewerUrl: `${env().APP_BASE_URL}/s/${shareId}#${shareToken}`,
    });
  });

  app.get("/v1/sessions", async (req) => {
    const userId = requireUser(req);
    const query = z
      .object({
        cursor: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(20),
      })
      .parse(req.query);
    const sessions = await prisma().liveSession.findMany({
      where: { creatorUserId: userId, deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const hasMore = sessions.length > query.limit;
    return {
      items: sessions.slice(0, query.limit).map(sessionView),
      nextCursor: hasMore ? sessions[query.limit - 1]!.id : null,
    };
  });

  app.get<{ Params: { id: string } }>("/v1/sessions/:id", async (req) => {
    const userId = requireUser(req);
    const session = await ownedSession(req.params.id, userId);
    const viewers = await viewerCount(session.id);
    const recording = await prisma().recording.findFirst({
      where: { liveSessionId: session.id, status: { not: "deleted" } },
      select: { id: true, status: true, durationMs: true, sizeBytes: true },
    });
    return {
      ...sessionView(session),
      viewers,
      recording: recording
        ? {
            id: recording.id,
            status: recording.status,
            durationMs: recording.durationMs,
            sizeBytes: Number(recording.sizeBytes),
          }
        : null,
    };
  });

  app.patch<{ Params: { id: string } }>("/v1/sessions/:id", async (req) => {
    const userId = requireUser(req);
    const session = await ownedSession(req.params.id, userId);
    const body = z
      .object({
        title: z.string().min(1).max(200).optional(),
        privacyMode: z.enum(PRIVACY_MODES).optional(),
        retentionDays: z.number().int().min(1).max(3650).optional(),
        interimReadingEnabled: z.boolean().optional(),
      })
      .parse(req.body);
    const data = Object.fromEntries(
      Object.entries(body).filter(([, v]) => v !== undefined),
    );
    const updated = await prisma().liveSession.update({
      where: { id: session.id },
      data,
    });
    await prisma().auditEvent.create({
      data: {
        organizationId: session.organizationId,
        actorUserId: userId,
        action: "session.update",
        entityType: "live_session",
        entityId: session.id,
        requestId: req.id,
        beforeState: {
          title: session.title,
          privacyMode: session.privacyMode,
          retentionDays: session.retentionDays,
        },
        afterState: body,
      },
    });
    return sessionView(updated);
  });

  for (const action of ["start", "pause", "resume", "end"] as const) {
    app.post<{ Params: { id: string } }>(
      `/v1/sessions/:id/${action}`,
      async (req) => {
        const userId = requireUser(req);
        const session = await ownedSession(req.params.id, userId);
        const db = prisma();
        switch (action) {
          case "start":
            await startSession(db, session.id);
            break;
          case "pause":
            await pauseSession(db, session.id);
            break;
          case "resume":
            await resumeSession(db, session.id);
            break;
          case "end": {
            await beginEndingSession(db, session.id);
            const recording = await db.recording.findFirst({
              where: { liveSessionId: session.id, status: { not: "deleted" } },
            });
            await completeSession(db, session.id, recording !== null);
            break;
          }
        }
        const updated = await db.liveSession.findUniqueOrThrow({
          where: { id: session.id },
        });
        return sessionView(updated);
      },
    );
  }

  app.post<{ Params: { id: string } }>(
    "/v1/sessions/:id/revoke-share",
    async (req) => {
      const userId = requireUser(req);
      const session = await ownedSession(req.params.id, userId);
      const db = prisma();
      const newToken = randomToken(24);
      const newShareId = randomToken(12);
      const updated = await db.liveSession.update({
        where: { id: session.id },
        data: {
          shareId: newShareId,
          shareTokenHash: sha256(newToken),
          shareRevokedAt: null,
        },
      });
      // existing viewer sessions are invalidated...
      await db.viewerSession.updateMany({
        where: { liveSessionId: session.id, endedAt: null },
        data: { endedAt: new Date() },
      });
      // ...and already-connected viewers are cut off on every API instance.
      // Ending the DB row alone only blocks NEW access: an open socket would
      // keep streaming transcript on a revoked link.
      await disconnectViewers(session.id, "access_revoked");
      await db.shareAccessEvent.create({
        data: { liveSessionId: session.id, action: "revoked" },
      });
      await db.auditEvent.create({
        data: {
          organizationId: session.organizationId,
          actorUserId: userId,
          action: "session.share_revoked",
          entityType: "live_session",
          entityId: session.id,
          requestId: req.id,
        },
      });
      return {
        ...sessionView(updated),
        shareToken: newToken,
        viewerUrl: `${env().APP_BASE_URL}/s/${newShareId}#${newToken}`,
      };
    },
  );

  app.delete<{ Params: { id: string } }>("/v1/sessions/:id", async (req) => {
    const userId = requireUser(req);
    const session = await ownedSession(req.params.id, userId);
    await prisma().liveSession.update({
      where: { id: session.id },
      data: {
        status: "deleted",
        deletedAt: new Date(),
        shareRevokedAt: new Date(),
      },
    });
    await prisma().viewerSession.updateMany({
      where: { liveSessionId: session.id, endedAt: null },
      data: { endedAt: new Date() },
    });
    // a deleted session must not keep streaming to already-connected viewers
    await disconnectViewers(session.id, "session_deleted");
    await prisma().auditEvent.create({
      data: {
        organizationId: session.organizationId,
        actorUserId: userId,
        action: "session.delete",
        entityType: "live_session",
        entityId: session.id,
        requestId: req.id,
      },
    });
    return { ok: true };
  });

  /** Server-side preflight: infrastructure + provider health for the studio. */
  app.get<{ Params: { id: string } }>(
    "/v1/sessions/:id/preflight",
    async (req) => {
      const userId = requireUser(req);
      const session = await ownedSession(req.params.id, userId);
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
      const provider = getProvider(primaryProviderName());
      checks["transcriptionProvider"] = provider
        ? await provider.healthCheck()
        : false;
      const languageSupported =
        provider?.supportedLanguages().includes(session.languageCode) ?? false;
      return {
        ok: Object.values(checks).every(Boolean),
        checks,
        provider: primaryProviderName(),
        languageSupported,
        maxSessionMinutes: env().MAX_SESSION_MINUTES,
      };
    },
  );
}
