# ADR-0004: Viewer audio is never uploaded or stored

**Status:** accepted

## Context

Read Aloud Mode requires the viewer's microphone. Viewers are often anonymous
and may be minors. Their speech is incidental to the product's purpose — we
only need their _position_ in the text.

## Decision

Viewer speech recognition runs **entirely in the browser** (Web Speech API).
Viewer audio is never uploaded, never stored, and never logged. Only the
derived reading position (word index, sentence index, state, confidence) is
reported to the server. There is no schema column anywhere that could hold
viewer audio or recognized text.

## Rationale

- The least-privilege data answer: we cannot leak what we never collect.
- The two pipelines get separate identifiers, permissions, rate limits, and failure states, so viewer recognition can never contaminate the canonical transcript.
- Removes an entire class of consent, retention, and child-safety obligations.

## Consequences

- Read Aloud availability depends on browser support (Chromium-family today; Firefox/WebKit fall back to manual reading, which is a complete fallback, not a degraded stub).
- Server-side recognition would be more consistent but is deliberately rejected.
- Enforced by an integration test asserting the viewer session row has no audio/text fields.
