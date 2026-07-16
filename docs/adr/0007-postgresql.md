# ADR-0007: PostgreSQL as the system of record

**Status:** accepted

## Decision

PostgreSQL 16 with Prisma. All canonical state (users, orgs, sessions,
segments, events, revisions, audit) lives here.

## Rationale

- The correctness requirements are relational and transactional: unique sequence/revision constraints, foreign keys with cascade, optimistic concurrency on corrections, audit rows written in the same transaction as the mutation.
- `UPDATE … RETURNING` gives lock-free atomic sequence allocation.
- Retention deletion relies on interval arithmetic and cascading deletes.

## Consequences

- The database is the throughput ceiling for ingest; read replicas and CDN delivery for completed sessions are the documented scaling path.
- Prisma migrations are tested from an empty database in CI.
