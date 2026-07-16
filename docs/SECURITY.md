# LiveRead — Security

## Authentication

- **Argon2id** password hashing (m=19456 KiB, t=2, p=1 — OWASP baseline).
- Sessions are opaque 256-bit random tokens; only the **SHA-256 hash** is stored (`auth_sessions.token_hash`). No JWT in the browser, **no token in localStorage**.
- Cookie: `HttpOnly`, `SameSite=Lax`, `Secure` in production, 14-day expiry, revocable (logout revokes; password reset revokes **all** sessions).
- Email verification required before starting a live session.
- Password reset tokens: 256-bit random, hashed at rest, 30-minute expiry, single-use.
- **Failed-login lockout**: 10 failures per email per 15 minutes (Redis counter). Login against a non-existent account still runs an Argon2 verify against a dummy hash, so timing does not reveal account existence.
- Uniform errors: "Incorrect email or password." for both wrong-user and wrong-password. Password-reset requests always return `{ok:true}`.

## Authorization & tenant isolation

Every creator-scoped query filters on `creatorUserId` (and `deletedAt: null`) at
the database layer — there is no "load then check" gap. Cross-tenant access
returns **404, not 403**, so a session's existence is not disclosed.

Covered by an integration test that asserts a second user gets 404 from
`GET /sessions/:id`, `GET transcript`, `POST start`, `DELETE`, and
`POST revoke-share`, and that listings never leak the row.

## Share links

- `share_id`: 96-bit random, URL-safe. `share_token`: 192-bit random, stored **only as SHA-256**.
- The token lives in the **URL fragment** (`/s/{id}#{token}`) — fragments are never sent to servers or written to proxy/access logs. The client exchanges it once for a scoped, session-bound viewer token.
- Revocation rotates both `share_id` and token **and** ends all existing viewer sessions.
- Optional expiry (`share_expires_at`) and passcode (Argon2id-hashed).
- Enumeration resistance: wrong token, unknown id, revoked, expired, and private all return an identical 404. Access is rate-limited to 30/min/IP.
- `X-Robots-Tag: noindex, nofollow` on `/s/*` (Next.js header) and on share API responses.
- Viewer tokens are required for transcript and recording reads; recordings are served as short-lived (10 min) presigned URLs, never public objects.

## Transport & headers

API sets `X-Content-Type-Options`, `X-Frame-Options: DENY`,
`Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`,
`Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, and HSTS
in production. Web sets the same plus `microphone=(self)`.

CORS is an explicit allowlist (`WEB_ORIGINS`), `credentials: true`.

## CSRF

Cookies are `SameSite=Lax` **and** every state-changing request with an
`Origin` header must match the allowlist (rejected with 403 otherwise).
Verified by an integration test using `origin: https://evil.example`.

## XSS

Transcript content is untrusted input. It is rendered exclusively as React text
nodes — `dangerouslySetInnerHTML` appears **nowhere** in the codebase
(verified by grep in the final audit). No HTML sanitization is needed because
no transcript HTML is ever produced.

## WebSocket security

Creator sockets require the session cookie **and** ownership; viewer sockets
require a valid, unexpired, unrevoked scoped viewer token. Viewers cannot
publish audio frames or control messages (`forbidden_message_type`). All frames
are Zod-validated; malformed input is rejected, never partially applied.
Duplicate creator tabs are handled by explicit takeover (close code 4001).

## Injection

Prisma parameterizes everything. The one raw query
(`UPDATE live_sessions SET last_sequence = last_sequence + 1 …`) uses a
`$queryRaw` **tagged template** with an interpolated parameter — not string
concatenation.

## Rate limiting & abuse

Global 300 req/min/IP in production (relaxed in dev/test so suites don't
self-throttle — production values are the ones that ship). Per-route: signup
10/15min, login 20/15min, password reset 5/15min, share access 30/min, abuse
report 5/10min, viewer position updates 120/min. Limits are Redis-backed
(shared across instances) and return `x-ratelimit-*` headers.

Cost controls: `MAX_SESSION_MINUTES` (180), `MAX_VIEWERS_PER_SESSION` (2000),
`MAX_CONCURRENT_SESSIONS_PER_USER` (3). Anonymous transcription is never
unlimited — viewers cannot trigger transcription at all.

## Upload validation

Recording chunks: `audio/webm` only, 8 MiB per chunk (route-level `bodyLimit`),
integer sequence bounded to 0–1,000,000, owner-checked, and only into the
creator's own `recordings/{sessionId}/chunks/` prefix. Keys are server-derived —
never client-supplied — so path traversal is structurally impossible.
JSON bodies are capped at 1 MiB; WS payloads at 1 MiB.

**Malware scanning is a documented boundary, not implemented** (LIMITATIONS.md).

## SSRF

The API makes no outbound requests to user-supplied URLs. The only egress is to
configured provider hosts (Deepgram) and internal infrastructure.

## Secrets

No secrets in source. All config is env-validated at boot (`env.ts`, Zod) and
the process refuses to start on invalid config. `COOKIE_SECRET` requires ≥32
chars. `.env.example` contains only local dev placeholders. Key rotation:
rotate `COOKIE_SECRET` (invalidates cookies), rotate provider keys at the
provider, rotate share tokens with "revoke & regenerate".

## Log redaction

pino redacts `req.headers.cookie`, `authorization`, `*.password`, `*.token`,
`*.shareToken`, `*.viewerToken`. Raw audio is never logged. Full transcript
text is not logged by default. IPs are stored only as salted hashes.

## Containers

Both images run as a **non-root** user (uid 10001). Multi-stage builds; no
build toolchain in the runtime layer.

## Audit logging

`audit_events` records actor, action, entity, request id, before/after state
for signup, session create/update/delete, share revocation, recording deletion.
`share_access_events` records granted/denied outcomes with hashed IP and
browser family. `incident_events` records degradations and abuse reports.

## Findings from the self-audit

See docs/FINAL_VERIFICATION.md. Known accepted risks:

1. **Dev-mode rate limits are relaxed** by design (`NODE_ENV !== production`). Production defaults are strict. Deploying with `NODE_ENV=development` would be a misconfiguration.
2. **No CAPTCHA / bot defense** on signup beyond rate limiting.
3. **No malware scanning** of uploaded audio (boundary documented).
4. **Second-factor authentication is not implemented.**
5. **Dependency/container/secret scanning** are wired into CI but their findings are only as current as the last CI run.
