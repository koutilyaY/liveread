# LiveRead — Architecture

## Overview

LiveRead is a real-time voice-to-text publishing platform with a synchronized
read-aloud mode. Two independent speech pipelines exist:

1. **Creator pipeline** — creator microphone → audio frame transport →
   streaming transcription provider → interim/final transcript segments →
   persistence → broadcast to viewers. Optionally the raw audio is archived as
   a recording.
2. **Viewer read-aloud pipeline** — viewer microphone → temporary in-browser
   speech recognition → normalized tokens → deterministic alignment engine →
   reading cursor (highlight + auto-scroll). Viewer audio is **never stored**
   and, in the default path, never leaves the browser.

The pipelines share nothing except the canonical finalized transcript, which
the viewer pipeline reads but can never write.

## Monorepo layout

```
liveread/
  apps/
    web/        Next.js App Router (TypeScript strict, Tailwind, TanStack Query, Zustand)
    api/        Fastify 5 + Prisma + PostgreSQL + Redis + S3 (also ships the worker entrypoint)
  packages/
    shared/     Zod event schemas, transcript state machine, normalization, alignment engine
  infra/        docker-compose services config (livekit, prometheus, k6 scripts)
  docs/         product, architecture, security, verification docs + ADRs
```

`packages/shared` is the contract layer: the same Zod schemas validate realtime
messages on the server (ingress) and on the client (before applying to UI
state). The alignment engine lives here so it can run in the browser (real
time) and in Node (tests, evaluation dataset).

## Runtime topology (local / single region)

```
 Browser (creator)                      Browser (viewer)
   │ mic → AudioWorklet PCM frames         │ mic → Web Speech API (local only)
   │ MediaRecorder → recording upload      │ alignment engine (in-browser)
   ▼                                       ▼
 ┌─────────────── WebSocket (auth: session cookie / share token) ───────────────┐
 │                                Fastify API                                   │
 │  auth · sessions · share · transcript · viewer-sessions · recordings ·       │
 │  health · metrics · OpenAPI                                                  │
 │        │                    │                        │                       │
 │        ▼                    ▼                        ▼                       │
 │  STT provider abstraction   TranscriptEvent log   Redis pub/sub fan-out      │
 │  (fake | deepgram | …)      (Postgres, per-session sequence)                 │
 └───────────────────────────────────────────────────────────────────────────────┘
        │                        │                        │
   PostgreSQL                 MinIO/S3                 Worker (BullMQ)
   (canonical state)          (recordings)             (finalization, retention,
                                                        second-pass, cleanup)
```

LiveKit (in compose) carries live creator **audio** to viewers when enabled;
transcript events always go over the WebSocket/replay channel, never bare
WebRTC data to every viewer from the browser.

## Transcript state machine

Segment states: `provisional → stable_interim → final → corrected`, with
`superseded` for interim text replaced by a different segmentation. Every
mutation is a `TranscriptEvent` with a **per-session monotonically increasing
sequence number** and a **per-segment revision number**:

- Events are idempotent: consumers ignore `(event_id)` duplicates and any event
  whose `revision_number` ≤ the segment's current revision.
- Replay: a client reconnects with `last_received_sequence`; the server streams
  all persisted events after it, then live events. Ordering is preserved by
  sequence; briefly out-of-order live events are buffered client-side.
- Finalized text changes only via explicit correction events, which write a
  `TranscriptRevision` audit row preserving the previous text.

Details: docs/TRANSCRIPT_STATE_MACHINE.md and docs/REALTIME_PROTOCOL.md.

## Alignment engine (viewer read-aloud)

Deterministic, explainable, no network calls. Three search scopes — local
tracking window, expanded recovery window, global reacquisition — with a
weighted score combining token edit distance, n-gram overlap, LCS, phonetic
similarity (English), position/direction continuity, and match history.
Hysteresis rules prevent cursor jumps on weak evidence; backward and long
forward jumps require stronger evidence. Full description:
docs/ALIGNMENT_ENGINE.md.

## Speech-to-text abstraction

`SttProvider` interface (start/sendAudioFrame/finish/cancel + capability
introspection). Implementations:

- `FakeSttProvider` — deterministic, script-driven; powers dev, CI, demo.
- `DeepgramSttProvider` — real streaming provider, enabled only when
  `DEEPGRAM_API_KEY` is set.
- Failover: circuit breaker tracks connect/timeout/error rates; on primary
  failure the session enters a visible `degraded` state, recording continues,
  and a post-session recovery transcription job is scheduled. Missing spans are
  marked as gaps — never fabricated.

## Security model (summary)

- Argon2id password hashing; HttpOnly SameSite=Lax session cookies; CSRF via
  origin verification on state-changing requests; rate limiting per IP and per
  account; failed-login lockout.
- Share links: 128-bit random `share_id` plus a separate bearer `share_token`
  stored only as a SHA-256 hash; revocable; optional expiry and passcode;
  `X-Robots-Tag: noindex` on share pages.
- Transcript text is treated as untrusted input and rendered as text nodes
  only (never `dangerouslySetInnerHTML`).
- WebSockets authenticate before subscribing; viewer sockets are scoped to one
  session and cannot publish transcript events.
- Tenant isolation enforced in every query via organization/creator scoping;
  covered by cross-tenant integration tests.

Details: docs/SECURITY.md, docs/THREAT_MODEL.md.

## Observability

Structured JSON logs (pino) with request IDs and session correlation IDs;
Prometheus metrics at `/metrics` (latency histograms for interim/final/
broadcast, WS connection gauges, provider error counters); OpenTelemetry
tracing hooks. Raw audio and full transcript text are never logged.

## Scaling path

Single-region compose today → horizontally scaled API behind a load balancer
(Redis pub/sub already decouples fan-out from the ingesting node; replay is
DB-backed so any node can serve reconnects) → regional deployments with a
routing layer, CDN for completed sessions, read replicas. See
docs/DEPLOYMENT.md and ADR-0011.
