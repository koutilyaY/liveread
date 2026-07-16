# LiveRead — Cost Model

Real-time transcription is the dominant cost and it scales with **creator
speaking minutes**, not viewer count. Viewers are cheap; speech is not.

## Drivers

| Driver                   | Scales with                                            | Notes                                                                                   |
| ------------------------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| **STT provider minutes** | creator minutes                                        | dominant cost. ~$0.004–0.01/min streaming at 2026 list prices — verify with your vendor |
| Recording storage        | creator minutes × retention                            | Opus ~0.5 MB/min → ~30 MB/hour                                                          |
| Egress                   | viewers × transcript size                              | text is tiny; CDN-cacheable for completed sessions                                      |
| LiveKit media            | viewers × audio minutes **when live audio is enabled** | the expensive viewer-side driver — off by default                                       |
| Database                 | events/session, sessions retained                      | ~2 events/sentence                                                                      |
| Compute                  | concurrent sessions + sockets                          | stateless, horizontally scalable                                                        |
| Workers                  | recordings finalized                                   | bursty, batchable                                                                       |

## Rough shape (verify against your own vendors)

A 60-minute session, 500 text-only viewers, 90-day retention:

| Item                                       | Estimate            |
| ------------------------------------------ | ------------------- |
| STT (60 min streaming)                     | $0.24–0.60          |
| Recording storage (~1.8 GB-month over 90d) | ~$0.04              |
| Transcript egress (500 × ~50 KB)           | ~$0.003             |
| DB + compute                               | fractions of a cent |
| **Total**                                  | **well under $1**   |

Enable live creator audio for those 500 viewers and LiveKit media minutes become
the largest line item — which is why `creator_audio_enabled` defaults to **off**.

## Controls implemented

| Control                        | Where                                       | Default                |
| ------------------------------ | ------------------------------------------- | ---------------------- |
| Session duration limit         | `MAX_SESSION_MINUTES`                       | 180                    |
| Viewer limit per session       | `MAX_VIEWERS_PER_SESSION`                   | 2000                   |
| Concurrent sessions per user   | `MAX_CONCURRENT_SESSIONS_PER_USER`          | 3                      |
| Retention cap                  | per session                                 | 7–365 days, 90 default |
| Provider-minute accounting     | `usageMetadata()` → `/v1/usage`             | always on              |
| Recording-storage accounting   | `/v1/usage`                                 | always on              |
| Rate limits (anonymous access) | per-IP, Redis                               | see SECURITY.md        |
| Retention cleanup              | hourly worker job                           | always on              |
| Stale-session reconciliation   | 10-min job, ends sessions abandoned >30 min | always on              |

**Anonymous viewers cannot trigger transcription at all** — only an
authenticated, email-verified creator can start a stream. That is the single
most important cost control: there is no unauthenticated path to provider spend.

## Not implemented

- Spending alerts / hard emergency provider kill-switch (`MAX_SESSION_MINUTES` bounds a single session, but there is no org-level monthly ceiling that trips automatically).
- Plan/tier enforcement and billing integration.
- Per-organization quota enforcement (the `organizations` columns exist; only per-user concurrency is enforced).

Before a public beta, wire provider-minute totals to an alert and a hard cutoff.
