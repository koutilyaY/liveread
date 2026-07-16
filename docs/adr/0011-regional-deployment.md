# ADR-0011: Regional deployment strategy

**Status:** accepted (design; not exercised against a real cloud)

## Decision

Single-region compose today. The path to regional deployment: stateless API
instances behind a per-region load balancer, regional LiveKit, a primary
Postgres with read replicas, regional Redis, CDN for static assets and completed
sessions. `region` is recorded on each session.

## Rationale

- Media must be near the creator; transcript reads must be near the viewer. These are different placement problems, which is why media and events use different transports (ADR-0001).
- Sequence allocation is atomic in the DB, so multiple API instances need no coordination — the design already supports horizontal scale-out within a region.
- Completed sessions are immutable and read-heavy: pure CDN work.

## Consequences

- Cross-region write latency to the primary is the known constraint for a globally-distributed creator base. Multi-primary is explicitly out of scope.
- **Not verified**: no Terraform module was applied to a real cloud. See LIMITATIONS.md.
