# LiveRead — Load Testing

## Environment (actual)

- **Host:** Apple Silicon macOS 25.5.0 (Darwin), Docker 29.0.1
- **Stack:** full `docker compose up --build` — Postgres 16, Redis 7, MinIO, API, worker, web — all on the same laptop as the load generator
- **Tool:** k6 (`grafana/k6` container, `--network host`)
- **Date:** 2026-07-15
- **Data:** demo seed (`Global Reading Demonstration`, 14 finalized segments, 28 events)

This is a **single-machine** test. It is not a substitute for a distributed test
against a regional deployment, and no claim here should be read as one.

## What the script does

`infra/k6/viewer-load.js`, run by `make test-load`:

- **viewers** — ramp 0→50 VUs over 15 s, hold 50 for 30 s, ramp down. Each iteration replays the full transcript (`GET /v1/share/:id/transcript`) — the read-heavy hot path real viewers hammer.
- **abuse** — 5 constant VUs guessing share tokens for 50 s; asserts a guessed token is **never** granted and is 404'd or 429'd.

### Why X-Forwarded-For appears in the script

LiveRead rate limits **per client IP** (anti-enumeration). k6 runs from one IP,
so without distinct client identities the test would measure the rate limiter,
not throughput. Each VU therefore sends its own `X-Forwarded-For`, which the API
honours **only** when `TRUST_PROXY` is configured — exactly as it would behind a
real load balancer. `make test-load` starts the API with `TRUST_PROXY=true` for
the run and restores the default afterwards.

With the production default (`TRUST_PROXY=false`) those headers are ignored and
the limiter correctly throttles the single real source IP. **This is not a
security bypass** — it is the reason the first run of this test found a genuine
bug (see below).

## Results (2026-07-15)

| Metric                                    | Value              | Threshold | Verdict |
| ----------------------------------------- | ------------------ | --------- | ------- |
| `http_req_duration{scenario:viewers}` p95 | **7.1 ms**         | <500 ms   | ✅      |
| `http_req_duration` avg                   | 5.17 ms            | —         |         |
| `http_reqs`                               | 3,508 (**69.2/s**) | —         |         |
| `checks{scenario:viewers}`                | **98.06%**         | >0.95     | ✅      |
| `checks{scenario:abuse}`                  | **100%**           | >0.95     | ✅      |
| guessed token granted                     | **0**              | 0         | ✅      |
| iterations                                | 3,507              | —         |         |

**The ~2% of replay checks that fail are legitimate 429s**, where two VUs mapped
onto the same simulated IP (`__VU % 254`) and exceeded the 60/min per-IP replay
limit. That is the rate limiter working, not an application error. It is
reported here rather than hidden by widening the limit.

## Bug found by this test (fixed)

The first run showed ~0% success. Root cause: `trustProxy: true` was hardcoded,
meaning the API trusted `X-Forwarded-For` from **anyone** — so any client could
forge an IP and mint a fresh rate-limit bucket per request, defeating throttling
_and_ share-link enumeration protection. Fixed: `TRUST_PROXY` is now
configuration, **defaults to `false`**, and is covered by `apps/api/src/env.test.ts`.

A load test that only ever produces green numbers isn't testing anything.

## Not tested (honest)

| Spec scenario                                     | Status                                                                                                                |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Many viewers on one session                       | ✅ 50 VUs, single machine                                                                                             |
| Share-token abuse                                 | ✅                                                                                                                    |
| Completed transcript reads                        | ✅                                                                                                                    |
| **Thousands of viewers**                          | ❌ needs distributed generators                                                                                       |
| **Many independent concurrent sessions**          | ❌                                                                                                                    |
| **WebSocket transcript event fan-out under load** | ❌ **most important gap** — k6's WS support exists but no scenario was written; only the REST replay path is measured |
| **Reconnection storms**                           | ❌                                                                                                                    |
| **Provider slowdown**                             | ❌ (circuit breaker is unit-covered, not load-covered)                                                                |
| **Redis pressure**                                | ❌ (restart recovery is covered by `make test-network`)                                                               |

## Reproduce

```bash
make up && make seed
make test-load
```
