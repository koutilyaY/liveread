# LiveRead — Disaster Recovery

## Objectives (targets, not guarantees)

| Scenario                | RPO                           | RTO                                        |
| ----------------------- | ----------------------------- | ------------------------------------------ |
| API instance loss       | 0                             | seconds (LB removes it; state is external) |
| Redis loss              | 0 (fan-out only)              | ~1 s measured (`make test-network`)        |
| Postgres loss → restore | last backup interval          | minutes–hours (data size)                  |
| Object storage loss     | 0 with versioning/replication | provider-dependent                         |
| Region loss             | last backup                   | hours (manual; **not automated**)          |

## What is where

| Component      | State                                      | Recovery                                  |
| -------------- | ------------------------------------------ | ----------------------------------------- |
| API / worker   | **stateless**                              | redeploy the image                        |
| Postgres       | **system of record**                       | restore from `pg_dump -Fc`                |
| Redis          | ephemeral (fan-out, rate limits, presence) | restart; clients replay from Postgres     |
| Object storage | recordings                                 | provider replication/versioning           |
| Client         | bounded frame buffer + local recording     | resumes from last ack; emergency download |

Losing Redis is **not** a data-loss event. That is a deliberate consequence of
DB-backed replay (ADR-0006) — verified, not assumed.

## Procedures

**Restore the database**

```bash
make backup            # pg_dump -Fc → backups/
make restore           # newest dump, --clean --if-exists (DESTRUCTIVE)
```

Both tested on this machine against real data (76 sessions survived a
backup→restore cycle). See FINAL_VERIFICATION.md.

**Rebuild a region**: provision Postgres/Redis/S3 → restore the dump → deploy
API/worker (`prisma migrate deploy` runs at container start) → deploy web →
point DNS. In-flight live sessions do **not** survive; creators must restart
them. Completed sessions and transcripts return intact.

**Corrupted transcript state**: `transcript_events` is an append-only log — the
segment table is a materialization of it. A session's segments can be rebuilt by
replaying its events in sequence order (`TranscriptStore` does exactly this in
the browser today; a server-side rebuild script is **not** written — recorded in
LIMITATIONS.md).

## Backup policy

- `pg_dump -Fc` (custom format, compressed, parallel-restorable).
- **Recommended production schedule** (not configured here): hourly incremental via WAL archiving + daily full; 30-day retention; encrypted at rest; stored in a _different_ failure domain from the primary.
- **Restore testing is mandatory** — an untested backup is a rumor. `make restore` exists so this is a one-liner in a drill.
- **Known conflict:** backups can outlive `retention_days` and reintroduce deleted data on restore. Production must bound backup retention and record it in its DPA (LIMITATIONS.md #22).

## Not implemented

- Automated cross-region failover, PITR/WAL archiving, backup encryption, automated restore drills. All are deployment-layer concerns; the application does not obstruct any of them.
