# ADR-0012: No runtime source-code self-modification

**Status:** accepted

## Context

The brief asks for "self-healing" behavior.

## Decision

"Self-healing" means **bounded automated recovery**: reconnect with exponential
backoff and jitter, circuit breakers, provider failover, health/readiness
checks, retry queues with dead-lettering, idempotent replay, worker restart
policies, transaction rollback, stale-session reconciliation, orphaned-upload
cleanup, and alerting. It explicitly does **not** mean a process that rewrites
production source code.

## Rationale

- Code that rewrites itself in production is unreviewable, unauditable, and untestable — every incident becomes archaeology.
- It breaks the deploy/rollback contract: the artifact running is no longer the artifact you shipped.
- It is a critical security hole: any code-execution bug becomes persistent, self-modifying malware.
- Code repair belongs in development and CI, where a human reviews the diff.

## Consequences

- Recovery is bounded and predictable; unrecoverable states surface as incidents with correlation IDs rather than silent mutation.
- Fixes ship through the normal pipeline.
