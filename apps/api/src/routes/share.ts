import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import {
  ipHash,
  randomToken,
  sha256,
  userAgentFamily,
  verifyPassword,
} from "../lib/crypto.js";
import { Errors } from "../lib/errors.js";
import { env } from "../env.js";

/**
 * Anonymous viewer access via share links.
 *
 * The share URL is /s/{shareId}#{shareToken} — the token travels in the URL
 * fragment (never sent to servers or logged by proxies). The client presents
 * it here once and receives a scoped, session-bound viewer token.
 *
 * Enumeration resistance: shareId lookups return a uniform 404; access is
 * rate-limited per IP.
 */

/**
 * Resolve a share link for a READ, enforcing every access condition.
 *
 * Every viewer-facing read must go through this. Checking expiry only at
 * token issuance is not enough: the viewer token is a bearer credential handed
 * out before expiry, so read paths that skip the check keep serving transcript
 * from an expired link to anyone holding an old token.
 *
 * All failures return an identical 404 so a probe cannot distinguish
 * "no such link" from "revoked" or "expired".
 */
async function resolveShareForRead(shareId: string, viewerToken?: string) {
  const db = prisma();
  const session = await db.liveSession.findFirst({
    where: { shareId, deletedAt: null },
  });
  if (!session || session.shareRevokedAt) throw Errors.notFound("Session");
  if (session.shareExpiresAt && session.shareExpiresAt < new Date()) {
    throw Errors.notFound("Session");
  }
  if (!viewerToken) throw Errors.unauthorized();
  const viewer = await db.viewerSession.findFirst({
    where: {
      liveSessionId: session.id,
      tokenHash: sha256(viewerToken),
      endedAt: null,
    },
  });
  if (!viewer) throw Errors.unauthorized();
  return { db, session, viewer };
}

export function registerShareRoutes(app: FastifyInstance): void {
  app.post<{ Params: { shareId: string } }>(
    "/v1/share/:shareId/access",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const db = prisma();
      const body = z
        .object({
          token: z.string().min(1).max(200),
          passcode: z.string().max(200).optional(),
        })
        .parse(req.body);

      const session = await db.liveSession.findFirst({
        where: { shareId: req.params.shareId, deletedAt: null },
      });
      const deny = async (action: string, sessionId?: string) => {
        if (sessionId) {
          await db.shareAccessEvent.create({
            data: {
              liveSessionId: sessionId,
              action,
              ipHash: ipHash(req.ip, env().COOKIE_SECRET),
              userAgentFamily: userAgentFamily(req.headers["user-agent"]),
            },
          });
        }
        // uniform error prevents share-id/passcode oracle
        throw Errors.notFound("Session");
      };

      if (!session || session.shareRevokedAt || session.status === "deleted") {
        return deny("denied_revoked", session?.id);
      }
      if (session.shareExpiresAt && session.shareExpiresAt < new Date()) {
        return deny("denied_expired", session.id);
      }
      if (sha256(body.token) !== session.shareTokenHash) {
        return deny("denied_token", session.id);
      }
      if (session.privacyMode === "passcode") {
        const ok =
          body.passcode !== undefined &&
          session.sharePasscodeHash !== null &&
          (await verifyPassword(session.sharePasscodeHash, body.passcode));
        if (!ok) {
          await db.shareAccessEvent.create({
            data: {
              liveSessionId: session.id,
              action: "denied_passcode",
              ipHash: ipHash(req.ip, env().COOKIE_SECRET),
              userAgentFamily: userAgentFamily(req.headers["user-agent"]),
            },
          });
          throw Errors.invalid("Incorrect passcode.", { needsPasscode: true });
        }
      }
      if (session.privacyMode === "private") {
        return deny("denied_revoked", session.id);
      }

      const currentViewers = await db.viewerSession.count({
        where: { liveSessionId: session.id, endedAt: null },
      });
      if (currentViewers >= env().MAX_VIEWERS_PER_SESSION) {
        throw Errors.tooMany("This session has reached its viewer limit.");
      }

      const viewerToken = randomToken(24);
      const viewer = await db.viewerSession.create({
        data: {
          liveSessionId: session.id,
          anonymousId: randomToken(8),
          authenticatedUserId: req.userId,
          tokenHash: sha256(viewerToken),
        },
      });
      await db.shareAccessEvent.create({
        data: {
          liveSessionId: session.id,
          viewerSessionId: viewer.id,
          action: "granted",
          ipHash: ipHash(req.ip, env().COOKIE_SECRET),
          userAgentFamily: userAgentFamily(req.headers["user-agent"]),
        },
      });

      reply.header("X-Robots-Tag", "noindex, nofollow");
      return {
        viewerSessionId: viewer.id,
        viewerToken,
        session: {
          id: session.id,
          title: session.title,
          languageCode: session.languageCode,
          status: session.status,
          creatorAudioEnabled: session.creatorAudioEnabled,
          interimReadingEnabled: session.interimReadingEnabled,
          lastSequence: session.lastSequence,
          startedAt: session.startedAt,
          endedAt: session.endedAt,
        },
      };
    },
  );

  /** Completed-session transcript for authorized viewers (REST replay). */
  app.get<{
    Params: { shareId: string };
    Querystring: { token?: string; after?: string };
  }>(
    "/v1/share/:shareId/transcript",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { db, session } = await resolveShareForRead(
        req.params.shareId,
        req.query.token,
      );

      const after = req.query.after ? parseInt(req.query.after, 10) : -1;
      const events = await db.transcriptEvent.findMany({
        where: { liveSessionId: session.id, sequenceNumber: { gt: after } },
        orderBy: { sequenceNumber: "asc" },
        take: 2000,
        select: { payload: true },
      });
      reply.header("X-Robots-Tag", "noindex, nofollow");
      return {
        events: events.map((e) => e.payload),
        lastSequence: session.lastSequence,
        status: session.status,
      };
    },
  );

  /** Recording playback URL for authorized viewers (completed sessions). */
  app.get<{
    Params: { shareId: string };
    Querystring: { token?: string };
  }>("/v1/share/:shareId/recording", async (req, reply) => {
    const { db, session } = await resolveShareForRead(
      req.params.shareId,
      req.query.token,
    );
    const recording = await db.recording.findFirst({
      where: { liveSessionId: session.id, status: "stored" },
    });
    if (!recording) throw Errors.notFound("Recording");
    const { presignGet } = await import("../lib/s3.js");
    const url = await presignGet(recording.storageKey, 600);
    reply.header("X-Robots-Tag", "noindex, nofollow");
    return {
      url,
      mimeType: recording.mimeType,
      durationMs: recording.durationMs,
      sizeBytes: Number(recording.sizeBytes),
    };
  });

  /** Abuse reporting for viewers. */
  app.post<{ Params: { shareId: string } }>(
    "/v1/share/:shareId/report",
    { config: { rateLimit: { max: 5, timeWindow: "10 minutes" } } },
    async (req) => {
      const db = prisma();
      const body = z
        .object({
          reason: z.enum(["abuse", "illegal", "spam", "other"]),
          details: z.string().max(2000).optional(),
        })
        .parse(req.body);
      const session = await db.liveSession.findFirst({
        where: { shareId: req.params.shareId, deletedAt: null },
      });
      if (!session) throw Errors.notFound("Session");
      await db.incidentEvent.create({
        data: {
          liveSessionId: session.id,
          component: "abuse_report",
          severity: "warning",
          errorCode: `report_${body.reason}`,
          message: (body.details ?? "").slice(0, 2000),
          recoverable: true,
          recoveryAction: "admin_review",
        },
      });
      return { ok: true };
    },
  );
}
