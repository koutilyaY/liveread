# ADR-0005: Deterministic, explainable alignment engine (no LLM in the hot path)

**Status:** accepted

## Context

The reading cursor updates several times per second per viewer and must feel
instant. It must also be debuggable when a reader complains "it lost me."

## Decision

A deterministic weighted scorer (edit distance, bigram overlap, LCS, phonetic
key, position/direction continuity) across three search scopes, with explicit
hysteresis. All timestamps are caller-supplied; no randomness; no network. A
language model may later assist _difficult recovery only_ — never the normal
cursor path.

## Rationale

- Latency: measured well under the 100 ms/update target, in-browser, offline.
- Testability: property-based tests and a 20-scenario evaluation dataset are only possible because identical inputs give identical outputs.
- Explainability: every result carries `reason_codes`.
- Cost: an LLM call per cursor update would be economically absurd at thousands of concurrent readers.

## Consequences

- Tuning is manual (weights and thresholds are explicit constants, documented).
- Adversarial cases (near-verbatim duplicate paragraphs) reacquire more slowly by design; documented in ALIGNMENT_ENGINE.md rather than papered over.
