# ADR-0003: Explicit interim/final segment state with per-segment revisions

**Status:** accepted

## Context

Streaming recognizers emit rapidly-changing interim text that later stabilizes.
Naive append produces duplicated partial phrases; naive replace loses ordering
and audit history.

## Decision

Every segment has a stable id and a state
(`provisional → stable_interim → final → corrected`, plus `superseded`), a
**per-segment revision number**, and a **per-session sequence number** on every
event. Interims update the open segment in place. Consumers ignore
`revision ≤ current`. Interim can never demote a finalized segment.

## Rationale

- Sequence gives transport ordering and replay; revision gives per-segment conflict resolution. Conflating them breaks one of the two.
- In-place interim update is what makes "no duplicate partial phrases persisted" structurally true rather than a cleanup job.
- Corrections write a `TranscriptRevision` row, so history survives.

## Consequences

- Clients need a small materializer (`TranscriptStore`) rather than naive appends. It is shared, so server and browser agree by construction.
- Read Aloud aligns against `final`/`corrected` only; stable-interim reading is an opt-in experiment, off by default.
