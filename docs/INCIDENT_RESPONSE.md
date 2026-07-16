# LiveRead — Incident Response

## Severity

| Sev | Definition            | Example                                                               |
| --- | --------------------- | --------------------------------------------------------------------- |
| 1   | Data loss or exposure | transcript loss after ack; share link leaking to unauthorized viewers |
| 2   | Core workflow down    | creators cannot go live; viewers receive no events                    |
| 3   | Degraded              | STT failover active; recording uploads failing                        |
| 4   | Cosmetic/localized    | one browser's UI defect                                               |

## First five minutes

1. `GET /readyz` — which dependency is red? (public mirror: `/status`)
2. `GET /metrics` — `liveread_stt_provider_errors_total`, `liveread_ws_connections`, broadcast latency p95.
3. `docker compose logs api worker` / your log backend — filter by `reqId` or session id.
4. `SELECT * FROM incident_events WHERE resolved_at IS NULL ORDER BY started_at DESC;`
5. Decide: degrade (keep recording, mark gaps) vs stop ingest.

## Playbooks

**STT provider failing** — expect automatic failover (one attempt) then
`degraded`; recording continues; creators see the degraded banner. Confirm the
circuit state in `/readyz`. Never hand-write transcript to fill a gap.

**Redis down** — live fan-out stops; **nothing is lost**. Clients reconnect with
backoff and replay from Postgres. Verified: recovery in ~1 s after a container
restart (`make test-network`). Rate limiting fails closed on errors.

**Postgres down** — Sev 1. Ingest cannot persist; `/readyz` 503s. Restore from
the newest dump (`make restore`); creators should keep local recordings via the
emergency download.

**Object storage down** — recordings fail to upload; transcription is
unaffected. The studio offers an emergency local download — tell affected
creators to use it.

**Recording stuck in `processing`** — the finalize job failed. Inspect the
BullMQ failed set; re-enqueue `finalize-recording` with the recording id.
Chunks remain in S3 until finalization succeeds.

**Share link leaked** — creator (or admin) runs revoke: rotates share id +
token and ends all viewer sessions immediately.

**Abuse report** — `incident_events` with `component = "abuse_report"`. Revoke
the link; preserve only what policy requires. (No reviewer UI yet — see
LIMITATIONS.md.)

## Correlation IDs

Every API error response carries `correlationId` (= `reqId`), and every user-
facing error surface shows it. Ask reporters for it first; it maps directly to
the request's log line.

## Communication

Post dependency status on `/status` (auto-derived from `/readyz`). For Sev 1–2,
notify affected creators directly — they are mid-broadcast and need to know
whether their audio is still being recorded.

## Postmortem

Blameless, within 5 business days for Sev 1–2. Must state: what users
experienced, what was lost (if anything), the correlation ids, the root cause,
and the test that will catch it next time. A fix without a regression test is
not a fix — the `trustProxy` bug in this build shipped with `env.test.ts`.
