# LiveRead — Transcript State Machine

## Segment states

```
                 stability ≥ 0.8
  provisional ─────────────────────► stable_interim
       │                                   │
       │  provider final                   │ provider final
       ▼                                   ▼
     final ◄───────────────────────────────┘
       │
       │ creator edit / accepted second-pass suggestion
       ▼
   corrected ──(further edits)──► corrected (revision + 1)

  any interim ──(re-segmentation / delete)──► superseded
```

| State            | Meaning                               | Read Aloud target?                                                    | Contrast                    |
| ---------------- | ------------------------------------- | --------------------------------------------------------------------- | --------------------------- |
| `provisional`    | interim, low stability (< 0.8)        | no                                                                    | italic, reduced             |
| `stable_interim` | interim, stability ≥ 0.8              | only if the creator enables the experimental setting (off by default) | reduced                     |
| `final`          | provider finalized                    | **yes**                                                               | normal                      |
| `corrected`      | human- or second-pass-corrected       | **yes**                                                               | normal (marked "corrected") |
| `superseded`     | replaced/deleted; hidden from display | no                                                                    | —                           |

Read Aloud aligns against `final` + `corrected` only, by default.
`interimReadingEnabled` is a per-session flag, default **false**.

## Invariants (each has a test)

1. **Interim replacement, not append** — the open segment is `UPDATE`d in place; a sentence produces exactly one segment row regardless of interim count. (`store.test.ts`, `api.integration.test.ts`)
2. **Sequence ordering** — per-session monotonic, allocated atomically; DB unique constraint `(live_session_id, sequence_number)`.
3. **Revision monotonicity** — consumers drop `revision_number ≤ current`; DB unique constraint `(transcript_segment_id, revision_number)`.
4. **Idempotency** — repeat `event_id` or already-applied sequence is a no-op.
5. **Finalized stability** — a late interim can never demote `final`/`corrected`.
6. **Audit** — every correction writes a `TranscriptRevision` with `previous_text`, `new_text`, `source`, `actor_user_id`.
7. **No duplicate partial phrases persisted** — identical consecutive interim text is suppressed before it becomes an event.
8. **Optimistic concurrency** — corrections require `expectedRevision`; a mismatch returns HTTP 409, never a silent overwrite.

## Revision sources

`provider_interim`, `provider_final`, `creator_edit`, `second_pass_correction`,
`system_recovery`.

Second-pass suggestions never silently replace creator-edited text — the
creator accepts or rejects, and the history is preserved either way.

## Session lifecycle

```
scheduled ──► preflight ──► live ⇄ paused
                             │  ╲
                             │   ╲ provider failure
                             │    ▼
                             │  degraded ──(recovery)──► live
                             ▼
                          ending ──► processing ──► completed
                                        (recording finalize)
   any ──► failed | deleted
```

Transitions are enforced server-side (`realtime/sessionControl.ts`) with an
allow-list per action; an invalid transition returns HTTP 409 with the current
status, rather than corrupting state. `degraded` never fabricates transcript —
it marks the gap and keeps recording.
