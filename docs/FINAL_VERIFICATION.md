# LiveRead — Final Verification

**Every number here was produced by a command executed in this environment on
2026-07-15.** Nothing is estimated, extrapolated, or aspirational. Where a thing
was not run, it says so.

## Environment

|                  |                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------ |
| Host             | Apple Silicon macOS 25.5.0 (Darwin)                                                  |
| Node             | v26.3.1 · pnpm 11.13.0 · Docker 29.0.1                                               |
| Stack under test | `docker compose up --build` — Postgres 16, Redis 7, MinIO, Mailpit, API, worker, web |
| STT provider     | `fake` (deterministic). **No paid credentials were used or available.**              |

## Results

### Static analysis

```
$ pnpm lint         → Tasks: 4 successful, 4 total
$ pnpm typecheck    → Tasks: 4 successful, 4 total   (TS strict, exactOptionalPropertyTypes, noUncheckedIndexedAccess)
$ pnpm format:check → clean
```

### Unit, property-based, evaluation

```
$ pnpm --filter @liveread/shared test
  Test Files  5 passed (5)
  Tests      59 passed (59)
```

| Suite                               | Tests | Covers                                                                                                                           |
| ----------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------- |
| `transcript/store.test.ts`          | 10    | interim replacement, finalization, duplicate suppression, stale revisions, out-of-order buffering, corrections, gap fast-forward |
| `text/normalize.test.ts`            | 12    | en/es/hi/ar/zh + mixed-language tokenization and normalization                                                                   |
| `alignment/engine.test.ts`          | 12    | tracking, fillers/omissions, mid-start, hysteresis, repeats, skips, backward, caught-up, manual reset, determinism               |
| `alignment/engine.property.test.ts` | 5     | fast-check: bounds, confidence range, no crashes, monotonicity, reacquisition, empty recognition                                 |
| `alignment/evaluation.test.ts`      | 20    | the full evaluation dataset (below)                                                                                              |

```
$ pnpm --filter @liveread/api test
  Tests  6 passed (6)      # env validation + trustProxy regression
```

### Integration (against dockerized Postgres/Redis/MinIO)

```
$ pnpm --filter @liveread/api test:integration
  Tests  21 passed (21)      # 2 files: api.integration + degradation.integration
```

Covers: signup/cookie-auth/logout, uniform login errors, **CSRF rejection**,
session lifecycle + invalid-transition 409, **cross-tenant isolation (404 on 5
routes + listing)**, share access with correct/wrong/unknown token, passcode
enforcement, **revocation invalidating live viewer sessions**, expiry,
sequenced persistence + interim replacement + REST replay, correction with
optimistic concurrency + revision history, **DB-level duplicate-sequence
impossibility**, retention hard-delete, viewer-audio non-retention,
**provider-failure degradation** (status + incident + no fabricated transcript +
recovery), **recording recovery** (survives degradation, idempotent resume).

### End-to-end (Playwright, real browsers)

```
$ make test-e2e
  15 passed (58.5s)
```

| Test                                            | Chromium | Firefox | WebKit |
| ----------------------------------------------- | -------- | ------- | ------ |
| creator + viewer full live flow with read-aloud | ✅       | ✅      | ✅     |
| viewer reconnect replays without duplicates     | ✅       | ✅      | ✅     |
| denied microphone → manual reading fallback     | ✅       | ✅      | ✅     |
| axe: landing/auth/legal pages                   | ✅       | ✅      | ✅     |
| axe: live viewer page with real transcript      | ✅       | ✅      | ✅     |

Plus `make test-provider-failure` (Chromium, API forced into STT outage):

| Test                                                                                                           | Result |
| -------------------------------------------------------------------------------------------------------------- | ------ |
| degraded visible to creator **and** viewer, recording continues, **no fabricated text**, session still endable | ✅     |

The main flow asserts, in one run: viewer joins **before any transcript
exists** → Read Aloud pressed early shows the waiting banner → fake provider
produces interim then final text → viewer receives it **without refresh** →
viewer reads and the word/sentence highlight tracks → viewer catches up →
creator resumes and **new text arrives** → creator ends → completed transcript
**still at the same link after reload**.

### Accessibility

```
$ make test-accessibility → 2 passed, 0 serious/critical axe violations
```

Two **real** violations were found and fixed (not suppressed): footer text at
`text-zinc-400` contrast, and interim transcript at `opacity-50` falling below
4.5:1.

### Load (k6, 50 VUs, single machine)

```
$ make test-load
  http_req_duration{scenario:viewers} p95 ......  7.1 ms   (threshold <500ms)  ✅
  checks{scenario:viewers} .....................  98.06%   (threshold >0.95)   ✅
  checks{scenario:abuse} .......................  100%                         ✅
  guessed share tokens granted .................  0                            ✅
  http_reqs ....................................  3,508 (69.2/s)
```

The ~2% of replay checks that "fail" are legitimate **429s** where two VUs
mapped onto the same simulated IP and hit the 60/min per-IP limit. That is the
rate limiter working. Reported, not hidden.

### Chaos

```
$ make test-network
  1) baseline readiness → ready ✓
  2) restarting redis container
  3) recovered after 1s ✓
```

### Infrastructure

| Check                                 | Result                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------ |
| `docker compose up --build`           | all 7 services up; api/postgres/redis/minio/mailpit **healthy**                      |
| `/healthz`                            | `{"ok":true}`                                                                        |
| `/readyz`                             | `{"ok":true,"checks":{"database":true,"redis":true,"objectStorage":true}}`           |
| Migrations from an **empty** database | `CREATE DATABASE liveread_migtest` → `prisma migrate deploy` → all tables created ✅ |
| Migrations idempotent on boot         | "No pending migrations to apply." ✅                                                 |
| `make backup`                         | 174 KB `pg_dump -Fc` archive ✅                                                      |
| `make restore`                        | restored; **76 live_sessions intact** ✅                                             |
| `make seed`                           | demo data + login work ✅                                                            |
| Production builds                     | `pnpm build` → 3 successful; Next.js 18 routes; API `tsc` ✅                         |
| Docker images                         | API + web build; both run **non-root** (uid 10001) ✅                                |

### Alignment evaluation dataset (20 scenarios, all passing)

Exact / slow / fast reading · missing articles · added fillers · mispronounced
proper nouns · repeated sentence · duplicate phrases across paragraphs · skip 1
· skip 5 · skip onto a duplicate · backward · begin mid-text · restart ·
background false recognition · empty recognition · mixed language · Mandarin
character path · 5,000+ word transcript · caught-up accuracy.

Thresholds asserted: mean word-position error ≤ 4 tokens · sentence accuracy
≥ 0.70 · lost-tracking < 5% · reacquisition ≤ 12 updates · **alignment latency
< 100 ms/update** (met on a 5,000+ word transcript).

## Bugs found by verification and fixed (with regression tests)

1. **`trustProxy: true` was hardcoded** → any client could forge `X-Forwarded-For`, mint a fresh rate-limit bucket per request, and defeat throttling _and_ share-link enumeration protection. Found by the k6 load test. Now `TRUST_PROXY` config, **defaults to `false`**, covered by `apps/api/src/env.test.ts`.
2. **WebSocket `subscribe` sent on open was dropped** during async auth setup → viewers got no replay. Found by a WS smoke test. Fixed with an early-message buffer on both sockets.
3. **Prisma engine mismatch in Docker** (`openssl-1.1.x` generated, `3.0.x` at runtime) → `/readyz` reported `database: false`. Found by readiness after `compose up`. Fixed by installing openssl in the build stage.
4. **Alignment: continuity prior vetoed genuine skips.** Found by property-based testing. Split scoring into position-independent _evidence_ (gates jumps) and continuity-modulated _ranking_.
5. **Two axe contrast violations** (above).
6. **Non-root container couldn't write Prisma engines** → fixed with `--chown` on copy.
7. **Web lint was silently passing** (`next lint || eslint src` with no eslint config). Now a real flat config; 0 `eslint-disable` remain in the codebase.
8. **The creator studio never received authoritative session status on connect** → a degradation raised during socket setup (and any degraded/paused state after a browser refresh) left the studio showing a stale "Live". Found by the new provider-failure E2E. The creator socket now sends `session.status` after setup, mirroring the viewer socket.
9. **Viewers joining an already-degraded session never saw the banner** → both stores applied `session.status` without deriving the `degraded` flag, so only transitions observed while listening were reflected. Found by the same test. Both stores now derive it, and also honour `incident.started`.

## Self-audit scan (clean)

```
TODO / FIXME / XXX / HACK ............ 0
"not implemented" / "placeholder" .... 0   (in source; docs intentionally discuss gaps)
": any" / "as any" / "<any>" ......... 0
ts-ignore / ts-expect-error .......... 0
eslint-disable ....................... 0
.skip / .only / xit / xdescribe ...... 0
dangerouslySetInnerHTML / innerHTML .. 0
hardcoded secrets .................... 0
```

The Terms page is a _deliberate, labeled_ legal placeholder — the only one, and
it is marked for qualified legal review as the spec requires.

## Acceptance criteria: 46 of 46 verified

All 46 are itemized with evidence in REQUIREMENTS_TRACEABILITY.md.

Criteria 27 (provider failure → visible degraded state) and 28 (recording
recovery) were **PARTIAL** at first audit — the code paths existed but nothing
forced a provider outage. Rather than accept that, a deterministic failure-
injection mode was added to the fake provider (`failMode: "start" | "mid"`,
never enabled by default) and both criteria are now covered by 6 integration
tests plus a UI-level E2E test. **That test immediately found two real bugs**
(see below), which is exactly why the gap was worth closing.

## What was NOT verified (do not infer otherwise)

1. **Deepgram against the live service** — adapter written to spec, never executed. _Blocker: missing credentials._
2. **Thousands of viewers** — tested at 50 VUs on one laptop. _Blocker: infrastructure._
3. **50,000-word auto-scroll smoothness** — alignment verified fast at 5,000+ words; browser scroll at 50k not measured.
4. **Real cloud/regional deployment** — designed, no IaC applied. _Blocker: infrastructure._
5. **Live creator audio via LiveKit** — not wired to the UI (LIMITATIONS #5).
6. **Screen readers with real AT**, formal WCAG audit, penetration test — none performed.
7. **WebSocket fan-out under load** — only the REST replay path was load-tested. The most significant load-testing gap.
8. Firefox/WebKit read-aloud uses the deterministic fake recognition driver; those engines' own recognizers were not exercised (Firefox has none).

Full list with reasons: LIMITATIONS.md.

## Reproduce everything

```bash
cd liveread
docker compose up --build -d
make seed
make verify              # lint + typecheck + unit + integration + builds
make test-e2e            # 15 tests, 3 browsers
make test-accessibility
make test-load
make test-network
make backup && make restore
```
