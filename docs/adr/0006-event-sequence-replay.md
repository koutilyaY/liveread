# ADR-0006: Database-backed event sequence and replay

**Status:** accepted

## Context

Viewers reconnect constantly (mobile networks, tab suspension). They must not
miss finalized transcript, nor see duplicates.

## Decision

Persist every transcript event with a per-session monotonic sequence allocated
by `UPDATE … SET last_sequence = last_sequence + 1 … RETURNING`, protected by a
unique constraint on `(live_session_id, sequence_number)`. Clients reconnect with
`last_received_sequence`; the server registers for live fan-out **first**, then
streams persisted events after that sequence.

## Rationale

- Atomic allocation means any API instance can ingest for any session — no sticky routing, no single writer.
- DB-backed replay means any instance can serve a reconnect.
- Registering before replaying closes the race where an event lands mid-replay and is lost by both paths. (Found by a real smoke test; the overlap is deduped client-side by event id.)
- Redis is fan-out only — losing Redis loses liveness, never durability.

## Consequences

- Every event is a DB write. Acceptable at one creator per session; the read-heavy viewer path is what scales, and it's cacheable/CDN-able.
- Replay is bounded by transcript length, not by connection count.
