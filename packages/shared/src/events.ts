import { z } from "zod";

/**
 * Realtime event contracts shared by the API (ingress/egress validation)
 * and the web client (validation before applying to UI state).
 *
 * Transcript events are the durable, replayable log. Everything else is
 * ephemeral session signalling.
 */

export const TRANSCRIPT_EVENT_TYPES = [
  "transcript.interim",
  "transcript.final",
  "transcript.corrected",
  "transcript.deleted",
] as const;

export const SEGMENT_STATUSES = [
  "provisional",
  "stable_interim",
  "final",
  "corrected",
  "superseded",
] as const;
export type SegmentStatus = (typeof SEGMENT_STATUSES)[number];

export const TranscriptEventSchema = z.object({
  event_id: z.string().uuid(),
  session_id: z.string().uuid(),
  segment_id: z.string().uuid(),
  /** Per-session monotonically increasing transport order. */
  sequence_number: z.number().int().nonnegative(),
  /** Per-segment revision; stale revisions must be ignored by consumers. */
  revision_number: z.number().int().nonnegative(),
  event_type: z.enum(TRANSCRIPT_EVENT_TYPES),
  text: z.string(),
  language_code: z.string().min(2),
  start_ms: z.number().int().nonnegative(),
  end_ms: z.number().int().nonnegative(),
  is_final: z.boolean(),
  /** Provider stability estimate for interim results, 0..1. */
  stability: z.number().min(0).max(1).nullable(),
  /** Provider confidence for final results, 0..1. */
  confidence: z.number().min(0).max(1).nullable(),
  created_at: z.string().datetime(),
});
export type TranscriptEvent = z.infer<typeof TranscriptEventSchema>;

export const SESSION_STATUSES = [
  "scheduled",
  "preflight",
  "live",
  "paused",
  "ending",
  "processing",
  "completed",
  "degraded",
  "failed",
  "deleted",
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const PRIVACY_MODES = [
  "private",
  "unlisted",
  "passcode",
  "organization",
  "public",
] as const;
export type PrivacyMode = (typeof PRIVACY_MODES)[number];

const sessionLifecycleEvent = <T extends string>(type: T) =>
  z.object({
    type: z.literal(type),
    session_id: z.string().uuid(),
    at: z.string().datetime(),
  });

export const SessionStatusEventSchema = z.object({
  type: z.literal("session.status"),
  session_id: z.string().uuid(),
  status: z.enum(SESSION_STATUSES),
  at: z.string().datetime(),
});

export const ViewerCountEventSchema = z.object({
  type: z.literal("viewer.count"),
  session_id: z.string().uuid(),
  count: z.number().int().nonnegative(),
});

export const CreatorAudioStatusSchema = z.object({
  type: z.literal("creator.audio_status"),
  session_id: z.string().uuid(),
  microphone: z.enum(["active", "muted", "paused", "disconnected"]),
});

export const CreatorConnectionStatusSchema = z.object({
  type: z.literal("creator.connection_status"),
  session_id: z.string().uuid(),
  connected: z.boolean(),
});

export const RecordingStatusSchema = z.object({
  type: z.literal("recording.status"),
  session_id: z.string().uuid(),
  status: z.enum(["idle", "recording", "uploading", "stored", "failed"]),
  duration_ms: z.number().int().nonnegative().optional(),
});

export const IncidentEventSchema = z.object({
  type: z.enum(["incident.started", "incident.resolved"]),
  session_id: z.string().uuid(),
  component: z.string(),
  severity: z.enum(["info", "warning", "critical"]),
  error_code: z.string(),
  message: z.string(),
  recoverable: z.boolean(),
});

export const HeartbeatSchema = z.object({
  type: z.literal("server.heartbeat"),
  at: z.string().datetime(),
  /** Highest persisted transcript sequence for gap detection. */
  last_sequence: z.number().int().nonnegative(),
});

export const TranscriptWireEventSchema = z.object({
  type: z.literal("transcript.event"),
  event: TranscriptEventSchema,
});

/** Everything the server may push to a viewer/creator socket. */
export const ServerMessageSchema = z.discriminatedUnion("type", [
  TranscriptWireEventSchema,
  SessionStatusEventSchema,
  ViewerCountEventSchema,
  CreatorAudioStatusSchema,
  CreatorConnectionStatusSchema,
  RecordingStatusSchema,
  IncidentEventSchema,
  HeartbeatSchema,
  sessionLifecycleEvent("session.created"),
  sessionLifecycleEvent("session.live"),
  sessionLifecycleEvent("session.paused"),
  sessionLifecycleEvent("session.resumed"),
  sessionLifecycleEvent("session.ending"),
  sessionLifecycleEvent("session.completed"),
  sessionLifecycleEvent("session.degraded"),
  z.object({
    type: z.literal("replay.complete"),
    session_id: z.string().uuid(),
    last_sequence: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("error"),
    code: z.string(),
    message: z.string(),
    correlation_id: z.string().optional(),
  }),
  z.object({
    type: z.literal("audio.ack"),
    stream_id: z.string(),
    last_accepted_sequence: z.number().int().nonnegative(),
  }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

/** Binary audio frames travel as binary WS messages; this is the JSON header
 *  variant used when binary transport is unavailable (base64 payload). */
export const AudioFrameSchema = z.object({
  type: z.literal("audio.frame"),
  session_id: z.string().uuid(),
  stream_id: z.string(),
  sequence_number: z.number().int().nonnegative(),
  capture_timestamp_ms: z.number().nonnegative(),
  sample_rate: z.number().int().positive(),
  channel_count: z.number().int().positive().max(2),
  encoding: z.enum(["pcm_s16le", "opus_webm"]),
  payload_b64: z.string(),
});
export type AudioFrame = z.infer<typeof AudioFrameSchema>;

export const ClientMessageSchema = z.discriminatedUnion("type", [
  AudioFrameSchema,
  z.object({
    type: z.literal("subscribe"),
    /** Replay everything after this sequence. -1 (or 0 with no history) means from the beginning. */
    last_received_sequence: z.number().int().min(-1),
  }),
  z.object({ type: z.literal("ping"), at: z.number() }),
  z.object({
    type: z.literal("creator.pause"),
  }),
  z.object({
    type: z.literal("creator.resume"),
  }),
  z.object({
    type: z.literal("creator.end"),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export function parseServerMessage(raw: string): ServerMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = ServerMessageSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = ClientMessageSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
