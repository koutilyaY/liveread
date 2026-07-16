# LiveRead — Data Retention

## Per-session retention

Creators choose 7 / 30 / 90 (default) / 365 days at session creation
(`live_sessions.retention_days`). The clock starts at `ended_at`.

## Enforcement

`retention-cleanup` runs **hourly** in the worker (BullMQ repeatable job,
`0 * * * *`):

```sql
SELECT id FROM live_sessions
WHERE ended_at IS NOT NULL
  AND deleted_at IS NULL
  AND ended_at + (retention_days || ' days')::interval < NOW()
```

For each expired session: delete every S3 object under
`recordings/{sessionId}/`, then **hard-delete** the session row. Foreign-key
cascades remove segments, events, revisions, viewer sessions, share-access
events, audio streams, and incidents.

Verified by an integration test that backdates `ended_at`, runs the real job,
and asserts both the session and its segments are gone.

## What survives, and why

| Data                                     | Retention                                 | Reason                                                |
| ---------------------------------------- | ----------------------------------------- | ----------------------------------------------------- |
| Transcript, events, revisions, recording | session retention window                  | product data                                          |
| `viewer_sessions`, `share_access_events` | with the session                          | abuse defense                                         |
| `audit_events`                           | tied to the organization, not the session | security/compliance obligations                       |
| `users` row after account deletion       | soft-deleted, **PII scrubbed**            | audit-trail integrity without retaining personal data |

## Immediate deletion

Retention is a ceiling, not a floor. Deleting a recording, transcript, session,
or account removes data immediately, without waiting for the window.

## Other scheduled jobs

| Job                       | Schedule     | Purpose                                                    |
| ------------------------- | ------------ | ---------------------------------------------------------- |
| `retention-cleanup`       | hourly       | above                                                      |
| `stale-session-reconcile` | every 10 min | end sessions abandoned >30 min with no active audio stream |
| `orphan-cleanup`          | on demand    | remove S3 chunk objects whose session no longer exists     |

## Backups

`make backup` produces a `pg_dump -Fc` archive; `make restore` restores the
newest one (both tested — see FINAL_VERIFICATION.md). **Known gap:** backups are
outside the retention job's reach, so a restored backup can reintroduce data
that retention had deleted. A production deployment must bound backup retention
to match, and document it in its own DPA. Recorded in LIMITATIONS.md.
