import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { parseClientMessage } from "@liveread/shared";
import { prisma } from "../lib/prisma.js";
import { registerSocket, unregisterSocket, publishToSession } from "./hub.js";
import { SessionTranscriber } from "./transcriptService.js";
import { startSttStream } from "../stt/registry.js";
import type { SttStream } from "../stt/provider.js";
import {
  beginEndingSession,
  completeSession,
  markDegraded,
  pauseSession,
  resumeSession,
} from "./sessionControl.js";
import { randomUUID } from "node:crypto";

/**
 * Creator ingest socket: audio frames in, acks + session events out.
 *
 * - Cookie-authenticated; the user must own the session.
 * - One active creator connection per session; a new tab takes over and the
 *   previous socket is closed with code 4001 (duplicate_tab).
 * - Frames are acknowledged with the last accepted sequence number so the
 *   client can resume its bounded buffer after reconnection.
 * - Provider failure fails over once; if that also fails the session is
 *   marked degraded (recording continues client-side) — no fabricated text.
 */

const activeCreatorSockets = new Map<string, WebSocket>();

/** Max frames buffered while auth/session setup runs, before the handler. */
const MAX_EARLY_MESSAGES = 32;

export function registerCreatorSocket(app: FastifyInstance): void {
  app.get<{ Params: { sessionId: string } }>(
    "/ws/creator/:sessionId",
    { websocket: true },
    async (socket, req) => {
      // buffer messages that arrive during async setup so nothing is dropped
      const earlyMessages: { raw: Buffer; isBinary: boolean }[] = [];
      const earlyListener = (raw: Buffer, isBinary: boolean) => {
        // bounded: a client must not be able to grow this buffer without
        // limit while auth/session setup is still running
        if (earlyMessages.length >= MAX_EARLY_MESSAGES) {
          socket.close(4429, "too_many_messages");
          return;
        }
        earlyMessages.push({ raw, isBinary });
      };
      socket.on("message", earlyListener);

      const db = prisma();
      const { sessionId } = req.params;
      const userId = req.userId;
      if (!userId) {
        socket.close(4401, "unauthorized");
        return;
      }
      const session = await db.liveSession.findFirst({
        where: { id: sessionId, creatorUserId: userId, deletedAt: null },
      });
      if (!session) {
        socket.close(4404, "session_not_found");
        return;
      }
      if (!["live", "paused", "degraded"].includes(session.status)) {
        socket.close(4409, `invalid_status:${session.status}`);
        return;
      }

      // duplicate-tab takeover
      const existing = activeCreatorSockets.get(sessionId);
      if (existing && existing.readyState === existing.OPEN) {
        existing.close(4001, "duplicate_tab");
      }
      activeCreatorSockets.set(sessionId, socket);
      await registerSocket(sessionId, socket, "creator");

      const segmentCount = await db.transcriptSegment.count({
        where: { liveSessionId: sessionId },
      });
      const transcriber = new SessionTranscriber(
        db,
        sessionId,
        session.languageCode,
        segmentCount,
      );

      const vocabulary = await db.vocabularyTerm.findMany({
        where: { liveSessionId: sessionId },
        select: { phrase: true, boost: true },
      });

      const streamId = randomUUID();
      let sttStream: SttStream | null = null;
      let lastAcceptedSeq = -1;
      let ended = false;
      let failedOverOnce = false;

      const audioStream = await db.audioStream.create({
        data: {
          id: streamId,
          liveSessionId: sessionId,
          ownerType: "creator",
          ownerId: userId,
          streamType: "canonical_creator",
          codec: "pcm_s16le",
          sampleRate: 16000,
          channelCount: 1,
        },
      });

      const sttCallbacks = {
        onInterim: (r: {
          text: string;
          stability: number;
          startMs: number;
          endMs: number;
        }) => {
          void transcriber
            .onInterim(r.text, r.stability, r.startMs, r.endMs)
            .catch((err) => req.log.error({ err }, "interim_persist_failed"));
        },
        onFinal: (r: {
          text: string;
          confidence: number | null;
          startMs: number;
          endMs: number;
        }) => {
          void transcriber
            .onFinal(r.text, r.confidence, r.startMs, r.endMs)
            .catch((err) => req.log.error({ err }, "final_persist_failed"));
        },
        onError: (err: Error) => {
          req.log.error({ err }, "stt_stream_error");
          void handleProviderFailure();
        },
        onClose: () => {},
      };

      async function startProvider(): Promise<void> {
        const result = await startSttStream(
          {
            streamId,
            languageCode: session!.languageCode,
            sampleRate: 16000,
            channelCount: 1,
            encoding: "pcm_s16le",
            vocabulary,
          },
          sttCallbacks,
          (from, to) => {
            req.log.warn({ from, to }, "stt_failover");
          },
        );
        sttStream = result.stream;
        if (result.degraded) {
          await markDegraded(
            db,
            sessionId,
            "transcription",
            "Live transcription is temporarily degraded. Audio recording continues.",
          );
        }
        await db.audioStream.update({
          where: { id: audioStream.id },
          data: { providerStreamId: `${result.providerName}:${streamId}` },
        });
      }

      async function handleProviderFailure(): Promise<void> {
        if (ended) return;
        if (failedOverOnce) {
          await markDegraded(
            db,
            sessionId,
            "transcription",
            "Live transcription is temporarily degraded. Audio recording continues.",
          );
          return;
        }
        failedOverOnce = true;
        try {
          sttStream?.cancelStream();
          await startProvider();
        } catch (err) {
          req.log.error({ err }, "stt_failover_failed");
          await markDegraded(
            db,
            sessionId,
            "transcription",
            "Live transcription is temporarily degraded. Audio recording continues.",
          );
        }
      }

      try {
        await startProvider();
      } catch (err) {
        req.log.error({ err }, "stt_start_failed");
        await markDegraded(
          db,
          sessionId,
          "transcription",
          "Live transcription could not start. Audio recording continues.",
        );
      }

      await publishToSession(sessionId, {
        type: "creator.connection_status",
        session_id: sessionId,
        connected: true,
      });

      // Send authoritative session status directly to this socket after setup.
      // Without it the studio shows whatever it assumed locally: a degradation
      // raised during setup (or an existing degraded/paused state after a
      // browser refresh) would never surface, because live pub/sub events only
      // cover transitions that happen after the client is listening.
      const current = await db.liveSession.findUnique({
        where: { id: sessionId },
        select: { status: true },
      });
      if (current && socket.readyState === socket.OPEN) {
        socket.send(
          JSON.stringify({
            type: "session.status",
            session_id: sessionId,
            status: current.status,
            at: new Date().toISOString(),
          }),
        );
      }

      let frameCount = 0;
      const handleMessage = (raw: Buffer, isBinary: boolean) => {
        void (async () => {
          if (isBinary) return; // binary transport reserved; JSON+b64 is v1
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
          switch (msg.type) {
            case "audio.frame": {
              if (msg.session_id !== sessionId) return;
              if (msg.sequence_number <= lastAcceptedSeq) return; // duplicate
              lastAcceptedSeq = msg.sequence_number;
              transcriber.noteFrame();
              const payload = Buffer.from(msg.payload_b64, "base64");
              sttStream?.sendAudioFrame(payload, msg.capture_timestamp_ms);
              frameCount++;
              if (frameCount % 10 === 0) {
                socket.send(
                  JSON.stringify({
                    type: "audio.ack",
                    stream_id: msg.stream_id,
                    last_accepted_sequence: lastAcceptedSeq,
                  }),
                );
              }
              break;
            }
            case "creator.pause":
              await pauseSession(db, sessionId);
              break;
            case "creator.resume":
              await resumeSession(db, sessionId);
              break;
            case "creator.end": {
              ended = true;
              await beginEndingSession(db, sessionId);
              await sttStream?.finishStream();
              await transcriber.flush();
              await db.audioStream.update({
                where: { id: audioStream.id },
                data: { endedAt: new Date(), status: "ended" },
              });
              const recording = await db.recording.findFirst({
                where: { liveSessionId: sessionId, status: { not: "deleted" } },
              });
              await completeSession(db, sessionId, recording !== null);
              socket.close(1000, "session_ended");
              break;
            }
            case "ping":
              socket.send(
                JSON.stringify({
                  type: "server.heartbeat",
                  at: new Date().toISOString(),
                  last_sequence: lastAcceptedSeq,
                }),
              );
              break;
            case "subscribe":
              break; // creators receive live events implicitly
          }
        })().catch((err) => req.log.error({ err }, "creator_socket_error"));
      };
      socket.off("message", earlyListener);
      socket.on("message", handleMessage);
      for (const m of earlyMessages) handleMessage(m.raw, m.isBinary);
      earlyMessages.length = 0;

      socket.on("close", () => {
        void (async () => {
          if (activeCreatorSockets.get(sessionId) === socket) {
            activeCreatorSockets.delete(sessionId);
          }
          await unregisterSocket(sessionId, socket, "creator");
          if (!ended) {
            sttStream?.cancelStream();
            await db.audioStream.updateMany({
              where: { id: audioStream.id, status: "active" },
              data: { endedAt: new Date(), status: "ended" },
            });
            await publishToSession(sessionId, {
              type: "creator.connection_status",
              session_id: sessionId,
              connected: false,
            });
          }
        })().catch((err) => req.log.error({ err }, "creator_close_error"));
      });
    },
  );
}
