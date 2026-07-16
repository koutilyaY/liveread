# ADR-0002: Fastify + Zod + Prisma instead of NestJS

**Status:** accepted — **deviation from the specification's stated preference**

## Context

The specification prefers NestJS (TypeScript, Fastify adapter, OpenAPI), and
says: "Prefer NestJS if sharing realtime event types and schemas with the
frontend creates a simpler, safer implementation."

## Decision

Use **Fastify 5 directly**, with Zod schemas in `@liveread/shared` and Prisma
for data access.

## Rationale

The stated condition for NestJS is schema sharing — and Zod in a shared
workspace package satisfies it _better_ than NestJS would:

- The **same** Zod schema object validates a realtime message on the server and on the client. NestJS's DTO/decorator model does not produce artifacts a browser can execute, so we would end up with Zod anyway _plus_ DTOs — two sources of truth.
- NestJS runs on Fastify regardless; we keep the same engine without the DI/decorator/module layer.
- Every cross-cutting concern the spec asks NestJS for is implemented: OpenAPI (`@fastify/swagger`, `/docs`), validation (Zod at every boundary), structured errors with correlation IDs, rate limiting, CORS/CSRF, health/readiness/metrics.

## Consequences

- No decorator-based DI. Domain logic lives in plain modules (`realtime/`, `stt/`, `jobs/`) that take dependencies as arguments — testable without a DI container, as the integration tests show.
- Teams expecting NestJS conventions face a small ramp-up.
- This deviation is recorded in BUILD_STATUS.md and REQUIREMENTS_TRACEABILITY.md rather than hidden.
