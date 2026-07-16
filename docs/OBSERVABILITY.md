# LiveRead — Observability

## Logs

Structured JSON via pino. Every request carries a UUID `reqId`; session-scoped
operations carry the session id. Redacted: `req.headers.cookie`,
`authorization`, `*.password`, `*.token`, `*.shareToken`, `*.viewerToken`.

**Never logged:** raw audio (creator or viewer). **Not logged by default:** full
transcript text.

## Metrics

Prometheus at `GET /metrics` (`prom-client`, plus default process metrics).

| Metric                                                        | Type      | Purpose                                   |
| ------------------------------------------------------------- | --------- | ----------------------------------------- |
| `liveread_http_request_duration_seconds{method,route,status}` | histogram | API latency                               |
| `liveread_ws_connections{kind}`                               | gauge     | live creator/viewer sockets               |
| `liveread_transcript_interim_latency_seconds`                 | histogram | frame receipt → interim emit (target <1s) |
| `liveread_transcript_final_latency_seconds`                   | histogram | phrase endpoint → final emit (target <3s) |
| `liveread_transcript_broadcast_latency_seconds`               | histogram | persist → socket write (target <300ms)    |
| `liveread_stt_provider_errors_total{provider,kind}`           | counter   | provider failures / circuit opens         |
| `liveread_stt_failovers_total{from,to}`                       | counter   | failover events                           |
| `liveread_duplicate_events_suppressed_total`                  | counter   | idempotency hits                          |
| `liveread_recording_chunks_stored_total`                      | counter   | recording upload progress                 |

Prometheus + Grafana ship in compose under the `observability` profile:
`docker compose --profile observability up -d`.

## Health

| Endpoint       | Meaning                                                                                             |
| -------------- | --------------------------------------------------------------------------------------------------- |
| `GET /healthz` | liveness — process is up                                                                            |
| `GET /readyz`  | readiness — Postgres, Redis, object storage, STT circuit state; **503** when any dependency is down |

`/readyz` powers the public `/status` page. It caught a real bug during the
build: the dockerized API reported `database: false` because Prisma had
generated an openssl-1.1.x engine while the runtime had 3.0.x.

## Viewer alignment telemetry

Reported by the client every 5 s (position only, never audio or text):
`currentWordIndex`, `currentSentenceIndex`, `alignmentState`,
`alignmentConfidence` → aggregated in `GET /v1/sessions/:id/analytics` as
alignment-state distribution (tracking / uncertain / lost / caught_up).
Alignment latency is measured directly in the evaluation suite (<100 ms target).

## Tracing

OpenTelemetry-compatible request ids and session correlation ids are in place.
**Gap:** no OTLP exporter is wired to a collector — spans are not emitted to a
tracing backend. Correlation is currently log-based. Recorded in LIMITATIONS.md.

## Alerts

Recommended (not configured — no Alertmanager in this environment):

| Alert                 | Condition                                                           |
| --------------------- | ------------------------------------------------------------------- |
| API not ready         | `/readyz` 503 for >2 min                                            |
| STT degraded          | `rate(liveread_stt_provider_errors_total[5m]) > 0`                  |
| Broadcast latency     | p95 `liveread_transcript_broadcast_latency_seconds` > 0.3 for 5 min |
| Recording failures    | any `recording.status = failed`                                     |
| Queue backlog         | BullMQ waiting depth > 100                                          |
| Retention job stalled | no `retention_cleanup_done` log in 2 h                              |
