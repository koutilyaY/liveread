# LiveRead — Backup & Restore

## Commands (both tested — see FINAL_VERIFICATION.md)

```bash
make backup    # docker exec liveread-postgres-1 pg_dump -U liveread -Fc liveread
               #   > backups/liveread-YYYYMMDD-HHMMSS.dump
make restore   # newest dump → pg_restore --clean --if-exists   (DESTRUCTIVE)
```

Verified on 2026-07-15: a 174 KB dump was taken, restored over the live
database, and all 76 `live_sessions` rows survived the round trip.

## What is and isn't covered

| Data                                            | In the dump? | Notes                                                                      |
| ----------------------------------------------- | ------------ | -------------------------------------------------------------------------- |
| users, orgs, memberships                        | ✅           | includes Argon2 hashes                                                     |
| sessions, segments, events, revisions           | ✅           | full transcript history                                                    |
| viewer sessions, share access, audit, incidents | ✅           |                                                                            |
| **recording audio**                             | ❌           | lives in object storage — back that up separately (versioning/replication) |
| Redis state                                     | ❌           | ephemeral by design; nothing to back up                                    |

A database restore therefore yields sessions whose `recordings.storage_key`
points at objects that must exist in S3. **Back up both, or restore both.**

## Restore into a fresh environment

```bash
docker compose up -d postgres
docker exec -i liveread-postgres-1 psql -U liveread -c "CREATE DATABASE liveread;"
docker exec -i liveread-postgres-1 pg_restore -U liveread -d liveread \
  --clean --if-exists < backups/<file>.dump
docker compose up -d          # API runs `prisma migrate deploy` on start
curl -s localhost:4000/readyz
```

## Migration safety

`prisma migrate deploy` runs automatically at API container start and is
idempotent ("No pending migrations to apply."). Migrations from an **empty**
database are verified in CI and were verified here against a freshly created
`liveread_migtest` database.

Rules for destructive migrations: expand → backfill → contract, across
releases; never drop a column in the same deploy that stops writing it — a
rollback would then hit a schema that has already lost data.

## Production recommendations (not configured here)

WAL archiving for PITR; hourly incrementals + daily fulls; 30-day retention
bounded to match `retention_days` obligations; encryption at rest; storage in a
separate failure domain; **scheduled restore drills**.
