# ADR-0010: Human-editable transcript with full revision history

**Status:** accepted

## Context

Automated transcription contains errors. The creator's reputation is attached
to the published text, and viewers read it aloud.

## Decision

Creators can correct any finalized segment. Corrections require
`expectedRevision` (optimistic concurrency, 409 on conflict), write a
`TranscriptRevision` row preserving the previous text, and broadcast a
`transcript.corrected` event to live viewers.

## Rationale

- Correction is a first-class product action, not an admin escape hatch.
- Optimistic concurrency prevents two tabs silently clobbering each other.
- History is required for audit and for second-pass suggestions that must never silently overwrite human edits.

## Consequences

- Revisions grow unbounded per segment; retention deletion removes them with the session.
- Viewers may see text change under them — accurate to the product promise ("interim text may be corrected", "final text is more stable"), and corrections are visibly marked.
