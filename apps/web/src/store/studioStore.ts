"use client";

import { create } from "zustand";
import {
  TranscriptStore,
  type SegmentView,
  type ServerMessage,
  type SessionStatus,
} from "@liveread/shared";
import { api, wsUrl } from "../lib/api";
import { ReconnectingSocket, type ConnectionState } from "../lib/ws";
import {
  int16ToBase64,
  startMicrophoneCapture,
  startRecorder,
  type CaptureHandle,
  type RecorderHandle,
} from "../lib/audio";

/**
 * Creator studio state: microphone capture → audio frames over WS, live
 * transcript display, recording chunk upload, session control.
 *
 * Bounded frame buffer: while the socket is down, up to MAX_BUFFERED_FRAMES
 * (≈60 s) are kept and resent after the acknowledged frame on reconnect;
 * older frames are dropped and counted as a gap (never unbounded memory).
 */

const MAX_BUFFERED_FRAMES = 600;

export interface SessionInfo {
  id: string;
  title: string;
  status: SessionStatus;
  languageCode: string;
  shareId: string;
  recordingEnabled: boolean;
  viewerUrl?: string;
}

interface StudioState {
  session: SessionInfo | null;
  connection: ConnectionState;
  micState: "idle" | "requesting" | "active" | "denied" | "error";
  micLevel: number;
  muted: boolean;
  status: SessionStatus | null;
  degraded: boolean;
  viewerCount: number;
  finalSegments: SegmentView[];
  interimSegments: SegmentView[];
  recordingState: "idle" | "recording" | "uploading" | "stored" | "failed";
  recordingSeconds: number;
  droppedFrames: number;
  ackSequence: number;
  error: string | null;

  load(sessionId: string): Promise<void>;
  goLive(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  end(): Promise<void>;
  setMuted(m: boolean): void;
  emergencyDownload(): void;
  teardown(): void;
}

const transcript = new TranscriptStore();
let socket: ReconnectingSocket | null = null;
let capture: CaptureHandle | null = null;
let recorder: RecorderHandle | null = null;
let frameSeq = 0;
let pendingFrames: { seq: number; b64: string; ts: number }[] = [];
let recordingId: string | null = null;
let recordingTimer: ReturnType<typeof setInterval> | null = null;
let streamId = "";

export const useStudioStore = create<StudioState>((set, get) => {
  function applyServerMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "transcript.event": {
        transcript.apply(msg.event);
        set({
          finalSegments: transcript.finalized(),
          interimSegments: transcript.interim(),
        });
        break;
      }
      case "audio.ack": {
        set({ ackSequence: msg.last_accepted_sequence });
        pendingFrames = pendingFrames.filter(
          (f) => f.seq > msg.last_accepted_sequence,
        );
        break;
      }
      case "session.paused":
        set({ status: "paused" });
        break;
      case "session.resumed":
      case "session.live":
        set({ status: "live" });
        break;
      case "session.completed":
        set({ status: "completed" });
        break;
      case "session.degraded":
        set({ status: "degraded", degraded: true });
        break;
      // authoritative status sent on (re)connect — covers degradations raised
      // during socket setup and state after a browser refresh
      case "session.status":
        set({ status: msg.status, degraded: msg.status === "degraded" });
        break;
      case "incident.started":
        if (msg.component === "transcription") set({ degraded: true });
        break;
      case "incident.resolved":
        set({ degraded: false });
        break;
      case "viewer.count":
        set({ viewerCount: msg.count });
        break;
      case "recording.status":
        if (msg.status === "stored") set({ recordingState: "stored" });
        if (msg.status === "failed") set({ recordingState: "failed" });
        break;
      default:
        break;
    }
  }

  function sendFrame(b64: string): void {
    const s = get();
    if (!s.session) return;
    const frame = { seq: frameSeq++, b64, ts: Date.now() };
    pendingFrames.push(frame);
    if (pendingFrames.length > MAX_BUFFERED_FRAMES) {
      pendingFrames.shift();
      set({ droppedFrames: s.droppedFrames + 1 });
    }
    socket?.send(
      JSON.stringify({
        type: "audio.frame",
        session_id: s.session.id,
        stream_id: streamId,
        sequence_number: frame.seq,
        capture_timestamp_ms: frame.ts,
        sample_rate: 16000,
        channel_count: 1,
        encoding: "pcm_s16le",
        payload_b64: frame.b64,
      }),
    );
  }

  function resendPending(ws: WebSocket): void {
    const s = get();
    if (!s.session) return;
    for (const frame of pendingFrames) {
      ws.send(
        JSON.stringify({
          type: "audio.frame",
          session_id: s.session.id,
          stream_id: streamId,
          sequence_number: frame.seq,
          capture_timestamp_ms: frame.ts,
          sample_rate: 16000,
          channel_count: 1,
          encoding: "pcm_s16le",
          payload_b64: frame.b64,
        }),
      );
    }
  }

  function openSocket(sessionId: string): void {
    socket?.close();
    socket = new ReconnectingSocket({
      url: wsUrl(`/ws/creator/${sessionId}`),
      onMessage: applyServerMessage,
      onState: (connection) => set({ connection }),
      onOpen: (ws) => resendPending(ws),
    });
    socket.connect();
  }

  async function uploadChunk(blob: Blob, seq: number): Promise<void> {
    const s = get();
    if (!s.session || !recordingId) return;
    try {
      await api(
        `/v1/sessions/${s.session.id}/recording/${recordingId}/chunk?seq=${seq}`,
        {
          method: "POST",
          headers: { "content-type": "audio/webm" },
          body: blob,
        },
      );
    } catch {
      // chunk retained locally in the recorder for emergency download
      set({ recordingState: "failed" });
    }
  }

  return {
    session: null,
    connection: "closed",
    micState: "idle",
    micLevel: 0,
    muted: false,
    status: null,
    degraded: false,
    viewerCount: 0,
    finalSegments: [],
    interimSegments: [],
    recordingState: "idle",
    recordingSeconds: 0,
    droppedFrames: 0,
    ackSequence: -1,
    error: null,

    async load(sessionId) {
      const s = await api<SessionInfo & { status: SessionStatus }>(
        `/v1/sessions/${sessionId}`,
      );
      set({ session: s, status: s.status });
      // resume a live session after refresh: reconnect socket + mic
      if (["live", "paused", "degraded"].includes(s.status)) {
        openSocket(sessionId);
      }
    },

    async goLive() {
      const s = get();
      if (!s.session) return;
      set({ micState: "requesting", error: null });
      try {
        capture = await startMicrophoneCapture({
          onFrame: (pcm) => sendFrame(int16ToBase64(pcm)),
          onLevel: (rms) => set({ micLevel: rms }),
        });
      } catch {
        set({
          micState: "denied",
          error:
            "Microphone access was blocked. Allow it in your browser settings, then try again.",
        });
        return;
      }
      streamId = crypto.randomUUID();
      try {
        await api(`/v1/sessions/${s.session.id}/start`, {
          method: "POST",
          body: "{}",
        });
      } catch (err) {
        capture.stop();
        capture = null;
        set({
          micState: "error",
          error: (err as Error).message,
        });
        return;
      }
      set({ micState: "active", status: "live" });
      openSocket(s.session.id);

      if (s.session.recordingEnabled) {
        try {
          const rec = await api<{ recordingId: string }>(
            `/v1/sessions/${s.session.id}/recording/begin`,
            { method: "POST", body: "{}" },
          );
          recordingId = rec.recordingId;
          recorder = startRecorder(capture.stream, (blob, seq) => {
            void uploadChunk(blob, seq);
          });
          if (recorder) {
            set({ recordingState: "recording" });
            recordingTimer = setInterval(
              () => set({ recordingSeconds: get().recordingSeconds + 1 }),
              1000,
            );
          } else {
            set({ recordingState: "failed" });
          }
        } catch {
          set({ recordingState: "failed" });
        }
      }
    },

    async pause() {
      capture?.setMuted(true);
      socket?.send(JSON.stringify({ type: "creator.pause" }));
      set({ status: "paused", muted: true });
    },

    async resume() {
      capture?.setMuted(false);
      socket?.send(JSON.stringify({ type: "creator.resume" }));
      set({ status: "live", muted: false });
    },

    async end() {
      const s = get();
      if (!s.session) return;
      if (recordingTimer) clearInterval(recordingTimer);
      if (recorder) {
        await recorder.stop();
        set({ recordingState: "uploading" });
        if (recordingId) {
          await api(
            `/v1/sessions/${s.session.id}/recording/${recordingId}/finish`,
            {
              method: "POST",
              body: JSON.stringify({ durationMs: s.recordingSeconds * 1000 }),
            },
          ).catch(() => set({ recordingState: "failed" }));
        }
      }
      const sent = socket?.send(JSON.stringify({ type: "creator.end" }));
      if (!sent) {
        await api(`/v1/sessions/${s.session.id}/end`, {
          method: "POST",
          body: "{}",
        }).catch(() => {});
      }
      capture?.stop();
      capture = null;
      set({ status: "completed", micState: "idle" });
    },

    setMuted(m) {
      capture?.setMuted(m);
      set({ muted: m });
    },

    emergencyDownload() {
      recorder?.downloadLocal(`liveread-recording-${Date.now()}.webm`);
    },

    teardown() {
      capture?.stop();
      capture = null;
      socket?.close();
      socket = null;
      if (recordingTimer) clearInterval(recordingTimer);
    },
  };
});
