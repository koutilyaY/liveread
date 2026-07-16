# LiveRead

**Speak live. Your words publish as text worldwide in near real time. Every
reader presses Read Aloud and the page follows _their_ voice, at _their_ pace.**

LiveRead is not a meeting bot or a summarizer. Its differentiated workflow is
viewer-controlled voice-following reading: while you keep speaking, a reader
anywhere can read your earlier sentences aloud and the highlight tracks them —
skipping, repeating, pausing, and catching up independently of your speed.

## Quick start (no credentials, no cloud)

```bash
cd liveread
docker compose up --build -d     # postgres, redis, minio, mailpit, api, worker, web
make seed                        # deterministic demo data
open http://localhost:3000/s/demo-reading-2026#demo-share-token-public
```

Press **Read Aloud Mode** and read the text out loud in Chrome, Edge, or Safari.
(Firefox has no Web Speech API — you'll get the manual reading cursor, which is
a complete fallback.)

**Demo login:** `demo@liveread.local` / `liveread-demo-2026`

For the live half, sign in, open _"Live Demo — press Start Speaking"_, pass
preflight, press Start — the deterministic fake speech provider produces interim
and final text with no paid credentials. Open the share link in another window
to watch text arrive live.

## What's here

| Path              |                                                                                                                                                           |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`        | Next.js App Router — landing, auth, dashboard, preflight, creator studio, viewer page, Read Aloud, transcript editor, account/usage/privacy/status        |
| `apps/api`        | Fastify + Prisma + Postgres + Redis + S3; WebSockets; STT abstraction; worker                                                                             |
| `packages/shared` | Zod event schemas, transcript state machine, language-aware tokenization, **the alignment engine** — all shared by server and browser                     |
| `infra`           | LiveKit, Prometheus, k6 load test, chaos script                                                                                                           |
| `docs`            | 26 documents + 12 ADRs. Start with [ARCHITECTURE](docs/ARCHITECTURE.md), [ALIGNMENT_ENGINE](docs/ALIGNMENT_ENGINE.md), [LIMITATIONS](docs/LIMITATIONS.md) |

## The two pipelines (never conflated)

|                           | Creator                                   | Viewer                            |
| ------------------------- | ----------------------------------------- | --------------------------------- |
| Purpose                   | canonical transcript + optional recording | locate the reader's position      |
| Audio leaves the browser? | yes → STT provider                        | **never**                         |
| Stored?                   | only with opt-in recording                | **never — no column can hold it** |
| Writes the transcript?    | yes                                       | **never**                         |

## Commands

```bash
make setup              # install, start infra, migrate, seed
make dev                # API + web on the host against dockerized infra
make up / down / logs   # full stack in Docker
make test               # unit + integration
make test-e2e           # Playwright: Chromium, Firefox, WebKit
make test-accessibility # axe-core
make test-load          # k6
make test-network       # chaos: Redis restart recovery
make verify             # lint + typecheck + tests + production builds
make backup / restore   # tested pg_dump / pg_restore
```

## Verified on this machine (2026-07-15)

|                                                 | Result                                       |
| ----------------------------------------------- | -------------------------------------------- |
| Unit + property + evaluation (shared)           | **65 passed**                                |
| API unit (env/trustProxy)                       | **6 passed**                                 |
| API integration (vs. dockerized pg/redis/minio) | **15 passed**                                |
| E2E — Chromium / Firefox / WebKit               | **9 passed**                                 |
| Accessibility (axe-core)                        | **2 passed**, 0 serious/critical             |
| Load (k6, 50 VUs)                               | p95 **7.1 ms**, 98% checks, 0 tokens guessed |
| Chaos (Redis restart)                           | recovered in **1 s**                         |
| `docker compose up --build`                     | all services healthy                         |
| Migrations from empty DB, backup/restore        | verified                                     |

Full detail, including what is _not_ verified: [FINAL_VERIFICATION.md](docs/FINAL_VERIFICATION.md)
and [LIMITATIONS.md](docs/LIMITATIONS.md).

## Honest product language

Near-real-time transcription · interim text may be corrected · final text is
more stable · viewer-controlled voice following · automatic recovery from common
connection failures · human-editable final transcript · best-effort global
connectivity.

We do not claim zero latency, perfect transcription, 100% recognition accuracy,
support for every browser, or equal quality across languages.

## Real speech provider

Optional. Without credentials, the fake provider runs everything and **no audio
leaves the deployment**.

```bash
STT_PROVIDER=deepgram
STT_FALLBACK_PROVIDER=fake
DEEPGRAM_API_KEY=…      # never commit
```

The Deepgram adapter is written to the documented protocol but **has not been
executed against the live service** — no credentials were available here.
See [SPEECH_PROVIDERS.md](docs/SPEECH_PROVIDERS.md).

## Not built

Live creator audio through LiveKit isn't wired to the UI; there's no UI
localization or RTL layout; no local Whisper; no second-pass transcription; no
org admin screens; no Terraform. All of it is enumerated with reasons in
[LIMITATIONS.md](docs/LIMITATIONS.md) — read that before deploying anything.
