# LiveRead — Viewer Alignment Engine

The alignment engine decides **where the viewer is reading** inside the
canonical finalized transcript. It is the product's most differentiated
component, and it is deliberately **deterministic**: no network calls, no
language model in the normal path, no randomness. The same inputs always
produce the same cursor.

Source: `packages/shared/src/alignment/engine.ts` (engine),
`packages/shared/src/text/normalize.ts` (tokenization/normalization),
`packages/shared/src/alignment/phonetic.ts` (phonetic key).

## Inputs

| Input                                           | Source                                                                                         |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| canonical finalized transcript tokens           | `setTranscriptTokens()`, rebuilt as final segments arrive                                      |
| viewer interim recognition tokens               | `update({ utteranceTokens, isFinal: false })`                                                  |
| viewer final recognition tokens                 | `update({ utteranceTokens, isFinal: true })`                                                   |
| previous matched index / confidence / direction | engine internal state                                                                          |
| time since last confident match                 | caller-supplied `timestampMs` (never `Date.now()` internally — that is what makes it testable) |
| manual cursor changes                           | `manualReset(displayWordIndex, timestampMs)`                                                   |

Viewer recognition **never** writes to the canonical transcript. The engine
only reads it.

## Normalization (matching keys only)

Normalization is applied to matching keys; the displayed transcript is never
modified. Per-language profiles (`getLanguageProfile`) control:

- Unicode NFKC normalization, lowercasing where the script has case
- punctuation and whitespace normalization
- apostrophe unification (`’` → `'`), configurable contraction expansion (en)
- number canonicalization (`1,000` → `1000`, `twenty` → `20` for en)
- diacritic stripping (Latin), Arabic tashkeel/alef/ya/ta-marbuta folding
- filler-word removal (`um`, `uh`, … per language)
- tokenization strategy: whitespace vs per-character (CJK), with embedded
  Latin/digit runs kept intact

Sentence boundaries recognize `.` `!` `?` `…` plus `。！？` (CJK), `؟` (Arabic),
`।॥` (Devanagari).

## Search scopes

| Scope                | When                                                                 | Range (default)                                       |
| -------------------- | -------------------------------------------------------------------- | ----------------------------------------------------- |
| Local tracking       | `tracking` and recently confident                                    | 12 tokens behind, 48 ahead                            |
| Recovery             | `uncertain` (4 s without a confident match, or 3 consecutive misses) | 40 behind, 160 ahead                                  |
| Global reacquisition | `lost` (10 s, or 10 consecutive misses), or no cursor yet            | entire finalized transcript, **bigram seed required** |

The bigram seed in global scope is what stops a single common word from
teleporting the cursor across a long transcript.

## Scoring

Each candidate end-position is scored on two axes:

**Evidence** (position-independent, weights normalized to 1):

| Signal                                                                       | Weight |
| ---------------------------------------------------------------------------- | ------ |
| token edit distance similarity (Levenshtein over the probe window, ±2 slack) | 0.30   |
| bigram overlap                                                               | 0.20   |
| longest common subsequence ratio                                             | 0.14   |
| phonetic similarity (metaphone-style key; contributes 0 for non-Latin)       | 0.12   |

Evidence is damped for very short probes (`0.6 + 0.4 × min(1, len/5)`), so a
one-word utterance cannot carry a jump.

**Ranking score** = `evidence × (1 − 0.24) + continuity × 0.24`, where
continuity is a Gaussian on the distance from the current cursor (asymmetric:
backward distance is penalized ~3× harder than forward).

The split matters: continuity **ranks** candidates so a nearby match wins ties
against a distant duplicate, but jump acceptance is judged on **evidence**
alone — otherwise the continuity prior would veto a genuine skip forever.

## Hysteresis (stability rules)

| Rule                                       | Default                                 |
| ------------------------------------------ | --------------------------------------- |
| accept threshold (normal forward movement) | score ≥ 0.55                            |
| max "normal" jump                          | 14 tokens                               |
| large forward jump                         | evidence ≥ 0.70 (0.60 while recovering) |
| backward jump (> 2 tokens)                 | evidence ≥ 0.74 (0.63 while recovering) |
| consecutive agreement for any jump         | 2 updates landing within ±9 tokens      |
| pending-jump TTL                           | 4 s                                     |
| minimum probe tokens                       | 2                                       |

A weak update does **not** cancel a pending jump confirmation (interim
recognition oscillates); the pending candidate expires by TTL instead. After a
confirmed jump the context tail is cleared, because context from before a
discontinuity is stale.

Probes are built from the last 8 utterance tokens. When the utterance is short,
both a context-padded probe and the raw-utterance probe are evaluated, so a
restart or skip is not drowned out by stale context.

## Result

```jsonc
{
  "matched_word_index": 348, // index into the DISPLAY token list
  "matched_sentence_index": 29,
  "matched_segment_id": "uuid",
  "confidence": 0.91,
  "state": "tracking", // waiting | tracking | uncertain | lost | caught_up
  "reason_codes": ["high_ngram_overlap", "continuous_forward_progress"],
  "candidate_count": 2,
}
```

Reason codes are emitted for explainability: `high_ngram_overlap`,
`high_edit_similarity`, `phonetic_support`, `position_continuity`,
`continuous_forward_progress`, `large_jump_confirmed`,
`backward_jump_confirmed`, `jump_pending_confirmation`, `jump_below_threshold`,
`weak_match_rejected`, `no_candidates`, `probe_too_short`, `no_transcript`,
`manual_reset`, `caught_up`.

## States

- `waiting` — no transcript yet, or Read Aloud started before the first sentence
- `tracking` — confident cursor
- `uncertain` — recovery window active
- `lost` — global reacquisition active
- `caught_up` — cursor within 2 tokens of the end of finalized text; when new
  finalized content arrives the engine returns to `tracking` automatically

## Manual override

`manualReset()` moves the cursor to the requested display word, sets confidence
to 0.5, clears the context tail and any pending jump, and resumes local
alignment there. It never snaps back to the old cursor. The viewer page wires
this to click/tap/Enter on any word, and it works **with or without** a
microphone — manual reading is a complete fallback.

## Evaluation dataset & thresholds

`packages/shared/src/alignment/evaluation.test.ts` — 20 scenarios covering the
spec list (exact/slow/fast reading, missing articles, fillers, mispronounced
proper nouns, repeated sentence, duplicate phrases across paragraphs, skip 1,
skip 5, backward, begin-in-middle, restart, background false recognition, empty
recognition, mixed language, Mandarin character path, 5,000+ word transcript,
caught-up accuracy).

Documented thresholds (asserted, not tuned to easy cases):

| Metric                                    | Threshold                         |
| ----------------------------------------- | --------------------------------- |
| mean word-position error (while tracking) | ≤ 4 tokens (≤ 6 for fast reading) |
| sentence-position accuracy                | ≥ 0.70 (≥ 0.60 fast reading)      |
| lost-tracking rate (clean reading)        | < 0.05                            |
| reacquisition after a discontinuity       | ≤ 12 updates                      |
| average alignment latency                 | < 100 ms/update                   |

**Documented exception:** skipping onto a near-verbatim duplicate of an earlier
paragraph is bounded at ≤ 30 updates, not 12. Hysteresis intentionally prefers
the earlier (closer) duplicate until following words diverge — flipping
instantly between repeated passages is the failure mode the spec forbids. This
is an explicit trade-off, recorded rather than tuned away.

Property-based tests (`engine.property.test.ts`, fast-check) additionally
assert across generated transcripts and noisy readers: bounded cursor, valid
confidence, no crashes, monotonic clean reading within ±6 tokens, skip
reacquisition, and that empty recognition never moves the cursor.

## Measured results

See docs/FINAL_VERIFICATION.md for the actual numbers on this machine.
