# ADR-0001: LiveKit for realtime media, WebSocket for transcript events

**Status:** accepted

## Context

Live creator audio may be heard by thousands of viewers. Transcript events must
reach every viewer with durable ordering and replay.

## Decision

Use **LiveKit** (self-hosted in compose, LiveKit Cloud or self-hosted in
production) as the SFU when live creator audio is enabled. Do **not** build a
custom SFU. Carry transcript events over an authenticated **WebSocket** with
Redis pub/sub fan-out and DB-backed replay — not over LiveKit data channels.

## Rationale

- Media fan-out is a solved, operationally deep problem; a bespoke SFU is a multi-year liability.
- Transcript events need durability, sequence ordering, and replay-after-reconnect. That is a database concern, not a media-transport one. Coupling them to the media layer would make transcript delivery depend on media session health.
- Viewers who only read (no audio) never pay for a media connection.

## Consequences

- Two transports to operate. Accepted: they fail independently, which is a feature.
- TURN required for restrictive networks (coturn in compose).
- Transcript delivery keeps working when media is unavailable — the common case for text-only readers.
