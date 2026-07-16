import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { parseClientMessage } from "@liveread/shared";
import { prisma } from "../lib/prisma.js";
import { env } from "../env.js";
import { sha256 } from "../lib/crypto.js";
import {
  registerSocket,
  unregisterSocket,
  viewerJoined,
  viewerLeft,
} from "./hub.js";

/**
 * Viewer subscription socket with durable replay.
 *
 * Flow (spec: LIVE TRANSCRIPT BROADCAST):
 *  1. connect with share id + viewer token (issued by POST /v1/share/:id/access)
 *  2. server validates access
 *  3. client sends {type:"subscribe", last_received_sequence}
 *  4. server registers for live fan-out FIRST, then streams missing events
 *     (client dedupes overlap by event id/revision), then replay.complete
 *  5. heartbeats re-authorize and carry the highest persisted sequence
 */

/** Max transcript events flushed to a viewer per replay batch. */
const REPLAY_PAGE_SIZE = 500;

/** Max frames buffered while access checks run, before the setup handler. */
const MAX_EARLY_MESSAGES = 32;

export function registerViewerSocket(app: FastifyInstance): void {
  app.get<{
    Params: { shareId: string };
    Querystring: { token?: string };
  }>("/ws/viewer/:shareId", { websocket: true }, async (socket, req) => {
    // buffer messages that arrive while access checks are still running,
    // so a subscribe sent immediately on open is never dropped
    const earlyMessages: Buffer[] = [];
    const earlyListener = (raw: Buffer) => {
      // bounded: an unauthenticated client must not be able to grow this
      // buffer without limit while the access checks are still running
      if (earlyMessages.length >= MAX_EARLY_MESSAGES) {
        socket.close(4429, "too_many_messages");
        return;
      }
      earlyMessages.push(raw);
    };
    socket.on("message", earlyListener);

    const db = prisma();
    const { shareId } = req.params;
    const viewerToken = req.query.token;
    if (!viewerToken) {
      socket.close(4401, "missing_token");
      return;
    }

    const session = await db.liveSession.findFirst({
      where: { shareId, deletedAt: null },
    });
    if (!session || session.shareRevokedAt) {
      socket.close(4404, "not_found");
      return;
    }
    if (session.shareExpiresAt && session.shareExpiresAt < new Date()) {
      socket.close(4410, "expired");
      return;
    }
    const viewerSession = await db.viewerSession.findFirst({
      where: {
        liveSessionId: session.id,
        tokenHash: sha256(viewerToken),
        endedAt: null,
      },
    });
    if (!viewerSession) {
      socket.close(4403, "invalid_viewer_token");
      return;
    }

    await registerSocket(session.id, socket, "viewer");
    await viewerJoined(session.id);

    /**
     * Re-authorize periodically. Access checked only at connect leaves a
     * viewer streaming forever on a stale grant: revocation is pushed
     * immediately via the hub, but expiry passes silently with no event to
     * react to, and a deleted session must also cut the stream.
     */
    const reauthorize = async (): Promise<boolean> => {
      const current = await db.liveSession.findFirst({
        where: { id: session.id, deletedAt: null },
        select: { shareId: true, shareRevokedAt: true, shareExpiresAt: true },
      });
      if (!current || current.shareRevokedAt || current.shareId !== shareId) {
        socket.close(4403, "access_revoked");
        return false;
      }
      if (current.shareExpiresAt && current.shareExpiresAt < new Date()) {
        socket.close(4410, "expired");
        return false;
      }
      const vs = await db.viewerSession.findFirst({
        where: { id: viewerSession.id, endedAt: null },
        select: { id: true },
      });
      if (!vs) {
        socket.close(4403, "access_revoked");
        return false;
      }
      return true;
    };

    const heartbeat = setInterval(() => {
      void (async () => {
        if (!(await reauthorize())) return;
        const s = await db.liveSession.findUnique({
          where: { id: session.id },
          select: { lastSequence: true },
        });
        if (socket.readyState === socket.OPEN) {
          socket.send(
            JSON.stringify({
              type: "server.heartbeat",
              at: new Date().toISOString(),
              last_sequence: s?.lastSequence ?? -1,
            }),
          );
        }
      })().catch((err) => req.log.error({ err }, "viewer_heartbeat_failed"));
    }, env().VIEWER_REAUTH_INTERVAL_MS);

    const handleMessage = (raw: Buffer) => {
      void (async () => {
        const msg = parseClientMessage(raw.toString());
        if (!msg) {
          socket.send(
            JSON.stringify({
              type: "error",
              code: "malformed_message",
              message: "Message failed schema validation.",
            }),
          );
          return;
        }
        if (msg.type === "ping") {
          // report the real watermark: a client using this for gap detection
          // would otherwise be told the session has no events at all
          const s = await db.liveSession.findUnique({
            where: { id: session.id },
            select: { lastSequence: true },
          });
          socket.send(
            JSON.stringify({
              type: "server.heartbeat",
              at: new Date().toISOString(),
              last_sequence: s?.lastSequence ?? -1,
            }),
          );
          return;
        }
        if (msg.type === "subscribe") {
          if (!(await reauthorize())) return;
          let after = msg.last_received_sequence;
          /**
           * Replay in bounded pages. A 50,000-word transcript is tens of
           * thousands of events; loading them all and flushing them into the
           * socket in one synchronous loop grows both the query result and the
           * ws send buffer without limit. Pages keep memory bounded and let
           * backpressure apply between batches.
           */
          for (;;) {
            const batch = await db.transcriptEvent.findMany({
              where: {
                liveSessionId: session.id,
                sequenceNumber: { gt: after },
              },
              orderBy: { sequenceNumber: "asc" },
              take: REPLAY_PAGE_SIZE,
              select: { sequenceNumber: true, payload: true },
            });
            if (batch.length === 0) break;
            for (const e of batch) {
              if (socket.readyState !== socket.OPEN) return;
              socket.send(
                JSON.stringify({ type: "transcript.event", event: e.payload }),
              );
            }
            after = batch[batch.length - 1]!.sequenceNumber;
            if (batch.length < REPLAY_PAGE_SIZE) break;
            // yield so a large replay cannot starve the event loop
            await new Promise((r) => setImmediate(r));
          }
          const current = await db.liveSession.findUnique({
            where: { id: session.id },
            select: { lastSequence: true, status: true },
          });
          socket.send(
            JSON.stringify({
              type: "replay.complete",
              session_id: session.id,
              last_sequence: current?.lastSequence ?? -1,
            }),
          );
          socket.send(
            JSON.stringify({
              type: "session.status",
              session_id: session.id,
              status: current?.status ?? "completed",
              at: new Date().toISOString(),
            }),
          );
          return;
        }
        // viewers may not publish audio frames or control messages
        socket.send(
          JSON.stringify({
            type: "error",
            code: "forbidden_message_type",
            message: "Viewers cannot publish this message type.",
          }),
        );
      })().catch((err) => req.log.error({ err }, "viewer_socket_error"));
    };
    socket.off("message", earlyListener);
    socket.on("message", handleMessage);
    for (const raw of earlyMessages) handleMessage(raw);
    earlyMessages.length = 0;

    const touch: Prisma.ViewerSessionUpdateArgs["data"] = {
      lastSeenAt: new Date(),
    };
    const touchInterval = setInterval(() => {
      void db.viewerSession
        .update({ where: { id: viewerSession.id }, data: touch })
        .catch((err) => req.log.warn({ err }, "viewer_touch_failed"));
    }, 30_000);

    socket.on("close", () => {
      clearInterval(heartbeat);
      clearInterval(touchInterval);
      void (async () => {
        await unregisterSocket(session.id, socket, "viewer");
        await viewerLeft(session.id);
      })().catch((err) => req.log.warn({ err }, "viewer_cleanup_failed"));
    });
  });
}
