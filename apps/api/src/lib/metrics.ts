import client from "prom-client";

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const httpRequestDuration = new client.Histogram({
  name: "liveread_http_request_duration_seconds",
  help: "HTTP request duration",
  labelNames: ["method", "route", "status"],
  buckets: [0.005, 0.02, 0.05, 0.1, 0.3, 1, 3],
  registers: [registry],
});

export const wsConnections = new client.Gauge({
  name: "liveread_ws_connections",
  help: "Active WebSocket connections",
  labelNames: ["kind"],
  registers: [registry],
});

export const transcriptInterimLatency = new client.Histogram({
  name: "liveread_transcript_interim_latency_seconds",
  help: "Audio frame receipt to interim event emit",
  buckets: [0.05, 0.1, 0.3, 0.5, 1, 2, 5],
  registers: [registry],
});

export const transcriptFinalLatency = new client.Histogram({
  name: "liveread_transcript_final_latency_seconds",
  help: "Phrase endpoint to final event emit",
  buckets: [0.1, 0.5, 1, 2, 3, 5, 10],
  registers: [registry],
});

export const transcriptBroadcastLatency = new client.Histogram({
  name: "liveread_transcript_broadcast_latency_seconds",
  help: "Event persistence to socket write",
  buckets: [0.005, 0.02, 0.05, 0.1, 0.3, 1],
  registers: [registry],
});

export const sttProviderErrors = new client.Counter({
  name: "liveread_stt_provider_errors_total",
  help: "STT provider errors",
  labelNames: ["provider", "kind"],
  registers: [registry],
});

export const sttFailovers = new client.Counter({
  name: "liveread_stt_failovers_total",
  help: "STT provider failovers",
  labelNames: ["from", "to"],
  registers: [registry],
});

export const duplicateEventsSuppressed = new client.Counter({
  name: "liveread_duplicate_events_suppressed_total",
  help: "Duplicate transcript events suppressed",
  registers: [registry],
});

export const recordingChunksStored = new client.Counter({
  name: "liveread_recording_chunks_stored_total",
  help: "Recording chunks persisted to object storage",
  registers: [registry],
});
