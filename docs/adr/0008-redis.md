# ADR-0008: Redis for fan-out, rate limiting, and queues

**Status:** accepted

## Decision

Redis for pub/sub transcript fan-out, viewer presence counters, rate-limit
buckets, login lockout counters, and BullMQ job queues.

## Rationale

- Decouples the ingesting API instance from the instances holding viewer sockets — horizontal scaling without sticky sessions.
- Rate limits must be shared across instances or they are trivially bypassed by hitting a different node.

## Consequences

- Redis is a liveness dependency, not a durability one: on loss, live fan-out stops but nothing is lost — clients reconnect and replay from Postgres. Verified by the chaos test (recovered in 1 s).
- Redis is a shared-failure domain for rate limiting; readiness reports it explicitly.
