# LiveRead — Realtime Protocol

All realtime messages are validated at runtime with Zod schemas from
`@liveread/shared` (`packages/shared/src/events.ts`) on **both** ends.
Malformed messages are rejected with an `error` frame, never partially applied.

## Endpoints

| Endpoint                          | Auth                                                      | Direction                                   |
| --------------------------------- | --------------------------------------------------------- | ------------------------------------------- |
| `GET /ws/creator/:sessionId`      | session cookie; must own the session                      | audio frames + control up, events/acks down |
| `GET /ws/viewer/:shareId?token=…` | scoped viewer token from `POST /v1/share/:shareId/access` | subscribe up, events down                   |

Viewer sockets are scoped to one session and **cannot** publish audio frames or
control messages — attempting either returns `forbidden_message_type`.

## Client → server

```jsonc
// creator audio (JSON+base64 transport; binary frames reserved)
{ "type": "audio.frame", "session_id": "uuid", "stream_id": "uuid",
  "sequence_number": 42, "capture_timestamp_ms": 1735689600000,
  "sample_rate": 16000, "channel_count": 1, "encoding": "pcm_s16le",
  "payload_b64": "…" }

{ "type": "subscribe", "last_received_sequence": 41 }   // -1 = from the start
{ "type": "creator.pause" } | { "type": "creator.resume" } | { "type": "creator.end" }
{ "type": "ping", "at": 1735689600000 }
```

## Server → client

`transcript.event` (the durable, replayable one) plus `session.status`,
`session.created|live|paused|resumed|ending|completed|degraded`,
`creator.audio_status`, `creator.connection_status`, `viewer.count`,
`recording.status`, `incident.started|resolved`, `server.heartbeat`,
`replay.complete`, `audio.ack`, `error`.

```jsonc
{
  "type": "transcript.event",
  "event": {
    "event_id": "uuid",
    "session_id": "uuid",
    "segment_id": "uuid",
    "sequence_number": 42,
    "revision_number": 3,
    "event_type": "transcript.interim",
    "text": "Today I want to explain",
    "language_code": "en-US",
    "start_ms": 12840,
    "end_ms": 15420,
    "is_final": false,
    "stability": 0.82,
    "confidence": null,
    "created_at": "2026-07-15T02:41:14.083Z",
  },
}
```

## Viewer connection flow

1. Client exchanges the share token (URL fragment) for a scoped viewer token.
2. Socket connects; server validates share id, revocation, expiry, viewer token.
3. Client sends `subscribe` with `last_received_sequence`.
4. **Server registers for live fan-out first, then streams persisted events
   after that sequence** — registering first means an event landing mid-replay
   is delivered rather than lost; the client dedupes the overlap by event id.
5. Server sends `replay.complete` + current `session.status`.
6. Heartbeats every 15 s carry the highest persisted sequence (gap detection).
7. Reconnect uses exponential backoff with jitter (`lib/ws.ts`).

Messages arriving during async setup are buffered and replayed into the handler
once setup completes — a `subscribe` sent immediately on open is never dropped.
(This was a real bug found by the WS smoke test, not a hypothetical.)

## Ordering, idempotency, replay

- **Sequence**: allocated by `UPDATE live_sessions SET last_sequence = last_sequence + 1 … RETURNING`, so any API instance can safely ingest. A DB unique constraint on `(live_session_id, sequence_number)` makes duplicates impossible (asserted by an integration test).
- **Revision**: per-segment; consumers ignore `revision_number ≤ current`.
- **Idempotency**: `TranscriptStore` ignores repeat `event_id`s and sequences at or below the applied watermark.
- **Out-of-order**: buffered (up to 64) and applied in sequence; a persistent gap fast-forwards rather than stalling forever.
- **Interim replacement**: an interim segment is updated in place — never appended repeatedly. Interim can never demote a finalized segment.

## Audio frames & backpressure

Frames are 100 ms of 16 kHz mono `pcm_s16le` produced by an AudioWorklet.
Server acks every 10th frame with `last_accepted_sequence`; the client keeps a
**bounded** buffer of 600 frames (~60 s) and resends unacked frames on
reconnect. Beyond the bound, the oldest provisional frames are dropped and
counted (surfaced in the studio as "dropped"), rather than growing memory
without limit. Duplicate frames (sequence ≤ last accepted) are ignored server-side.

## Fan-out

Events are persisted, then published to `session:{id}:events` on Redis pub/sub.
Every API instance holding sockets for that session relays to its local
sockets. Replay is DB-backed, so a reconnect can be served by any instance.
