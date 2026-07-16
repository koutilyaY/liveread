# LiveRead — Build Status

**Status: complete for the scope built and verified.** Phase-by-phase record;
final results in docs/FINAL_VERIFICATION.md, gaps in docs/LIMITATIONS.md.

## Environment (verified 2026-07-15)

| Tool    | Version                | Status                                               |
| ------- | ---------------------- | ---------------------------------------------------- |
| Node.js | v26.3.1                | OK                                                   |
| pnpm    | 11.13.0                | installed via `npm i -g pnpm` (corepack unavailable) |
| Docker  | 29.0.1, daemon running | OK                                                   |
| make    | GNU Make 3.81          | OK                                                   |
| ffmpeg  | not on host            | installed **inside** the API image                   |

## Repository constraint

The host repo (`supply_chain_project`) is an existing Python supply-chain
analytics project. LiveRead is fully self-contained under `liveread/`; nothing
outside it was modified.

## Phases

| Phase | Description                                                                                                                          | Status                                                      |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| 0     | Inspect & plan                                                                                                                       | DONE                                                        |
| 1     | Monorepo & infrastructure (compose: postgres, redis, minio, mailpit, livekit, coturn, api, worker, web)                              | DONE                                                        |
| 2     | Auth & data model (13 entities, argon2id, orgs, share links, audit, tenant isolation)                                                | DONE                                                        |
| 3     | Creator audio & session control (preflight, AudioWorklet capture, framing+acks, recording, studio)                                   | DONE                                                        |
| 4     | Streaming transcription (abstraction, fake + deepgram, interim/final, persistence, revisions, broadcast, replay)                     | DONE                                                        |
| 5     | Viewer live page (share validation, live transcript, reconnection, display states, mobile, a11y)                                     | DONE                                                        |
| 6     | Read Aloud Mode (viewer mic, in-browser recognition, alignment engine, highlighting, auto-scroll, caught-up, recovery, manual reset) | DONE                                                        |
| 7     | Completed sessions (playback, editor, corrections + revision history, downloads, retention/deletion)                                 | DONE (no click-to-seek; no second-pass — LIMITATIONS #4/#6) |
| 8     | Reliability & security (failover, circuit breaker, retry/DLQ, abuse controls, headers, rate limits, chaos, tenant isolation)         | DONE                                                        |
| 9     | Global-readiness (tokenization for 6 languages, provider routing, load tests, cost controls, metrics)                                | PARTIAL — no UI i18n/RTL (LIMITATIONS #1/#2)                |
| 10    | Final audit                                                                                                                          | DONE                                                        |

## Verified checkpoints (executed, not assumed)

- [x] `pnpm install`, `pnpm lint`, `pnpm typecheck`, `pnpm format:check` — all clean
- [x] Unit tests: 59 (shared) + 6 (api)
- [x] Property-based alignment tests (fast-check), stable across reruns
- [x] Alignment evaluation dataset: 20 scenarios within documented thresholds
- [x] Integration tests: 21, against dockerized Postgres/Redis/MinIO
- [x] `docker compose up --build` — all services healthy
- [x] E2E: 15 across Chromium, Firefox, WebKit
- [x] Provider-failure E2E (forced STT outage): degraded UI, recording continues, no fabricated text
- [x] Accessibility: 0 serious/critical axe violations (2 real ones fixed)
- [x] Load: k6 50 VUs, p95 7.1 ms, 0 tokens guessed
- [x] Chaos: Redis restart, recovered in 1 s
- [x] Production builds (`pnpm build`) + both Docker images (non-root)
- [x] Migrations from an empty database; idempotent on boot
- [x] Seed + deterministic demo, no paid credentials
- [x] Backup and restore (76 sessions survived a round trip)
- [x] Self-audit scan: 0 TODO/any/ts-ignore/skipped tests/dangerouslySetInnerHTML/hardcoded secrets

## Deviations from the specification (recorded, not hidden)

1. **Fastify instead of NestJS** — ADR-0002 explains why the spec's own condition ("if sharing realtime event types and schemas with the frontend creates a simpler, safer implementation") points to Zod-in-a-shared-package rather than NestJS DTOs.
2. **LiveKit live creator audio is provisioned but not wired to the UI** — LIMITATIONS #5.
3. **No UI localization / RTL** — tokenization and alignment are multilingual and tested; the chrome is English — LIMITATIONS #1/#2.
4. **Deepgram adapter is unverified against the live service** — no credentials in this environment — LIMITATIONS #13.
5. **No Terraform, no second-pass transcription, no org admin UI** — LIMITATIONS #4/#7/#8.
