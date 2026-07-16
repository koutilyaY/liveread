# LiveRead — Threat Model

## Assets

1. Creator audio (live + recorded)
2. **Viewer audio** — protected by never collecting it (ADR-0004)
3. Transcript content (may be unpublished/sensitive)
4. Share links (capability tokens)
5. Account credentials / sessions
6. Provider credentials (spend)

## Actors

| Actor                 | Capability                                   |
| --------------------- | -------------------------------------------- |
| Anonymous internet    | HTTP/WS to public endpoints                  |
| Authorized viewer     | holds a share link                           |
| Authenticated creator | owns their sessions                          |
| Malicious creator     | uses the platform to publish abusive content |
| Compromised vendor    | STT/storage provider                         |
| Insider               | database/log access                          |

## Threats and controls (STRIDE-ish)

| #   | Threat                                             | Control                                                                                                              | Residual                                                                                       |
| --- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | **Share-link enumeration**                         | 96-bit random id + separate 192-bit token (hashed at rest); uniform 404 for wrong/unknown/revoked/expired; 30/min/IP | brute force is infeasible; a _leaked_ link is a real risk → revocation exists                  |
| 2   | **Leaked share link**                              | creator revokes → rotates id+token, ends all viewer sessions; optional expiry + passcode                             | window between leak and revocation                                                             |
| 3   | **Token in server logs**                           | token travels in the **URL fragment**, never sent to servers; pino redacts token fields                              | user pasting a link into a third party                                                         |
| 4   | **IDOR across tenants**                            | every query scoped by `creatorUserId` at the DB layer; 404 not 403; integration-tested                               | —                                                                                              |
| 5   | **Rate-limit bypass via forged `X-Forwarded-For`** | `TRUST_PROXY` defaults **false**; explicit allowlist behind a LB; unit-tested                                        | misconfiguration (documented in DEPLOYMENT.md) — **this was a real bug found by load testing** |
| 6   | **XSS via transcript**                             | rendered as React text nodes only; `dangerouslySetInnerHTML` appears nowhere (grep-verified)                         | —                                                                                              |
| 7   | **CSRF**                                           | SameSite=Lax + Origin allowlist on all mutations; tested                                                             | —                                                                                              |
| 8   | **Credential stuffing**                            | Argon2id; 10-fail/15-min lockout; uniform errors; dummy-hash verify on unknown accounts                              | no MFA, no CAPTCHA                                                                             |
| 9   | **Session theft**                                  | HttpOnly+Secure+SameSite cookies; hashed at rest; revocable; reset revokes all                                       | XSS would still be fatal — hence #6                                                            |
| 10  | **Viewer audio exposure**                          | not collected, not uploaded, no column can hold it                                                                   | Chrome's own Web Speech uploads to Google (browser behavior; disclosed)                        |
| 11  | **Malicious upload**                               | content-type + 8 MiB cap; server-derived keys (no traversal); owner-checked                                          | **no malware scanning**                                                                        |
| 12  | **SSRF**                                           | no outbound requests to user-supplied URLs                                                                           | —                                                                                              |
| 13  | **SQL injection**                                  | Prisma parameterization; the single raw query uses a tagged template                                                 | —                                                                                              |
| 14  | **Provider spend abuse**                           | only email-verified creators can stream; session/viewer/concurrency caps                                             | no org-level monthly kill-switch                                                               |
| 15  | **Abusive content**                                | report endpoint → `incident_events`; link revocation; unlisted not indexed                                           | **no reviewer tooling / takedown workflow**                                                    |
| 16  | **Vendor compromise**                              | fake provider default = zero egress; credential-gated real provider; recording opt-in                                | vendor holds creator audio when enabled                                                        |
| 17  | **Insider DB access**                              | passwords Argon2id; tokens hashed; IPs hashed; audit log                                                             | transcripts are plaintext by necessity                                                         |
| 18  | **DoS**                                            | per-route + global rate limits (Redis-shared); bounded buffers; request-size caps                                    | no upstream WAF/CDN shield configured                                                          |
| 19  | **WS abuse**                                       | auth before subscribe; viewers cannot publish; Zod validation; 1 MiB payload cap                                     | —                                                                                              |
| 20  | **Duplicate/replay of transcript events**          | unique `(session, sequence)`; per-segment revisions; idempotent event ids                                            | —                                                                                              |

## Trust boundaries

```
Internet ──► CDN/LB ──► API (validates everything; trusts nothing from clients)
                         ├─► Postgres   (trusted, network-isolated)
                         ├─► Redis      (trusted, network-isolated)
                         ├─► S3         (semi-trusted: server-derived keys only)
                         └─► STT vendor (untrusted output: text is escaped downstream)
Browser ──► Web Speech (viewer audio never crosses into our boundary)
```

## Explicitly accepted

- No MFA, no CAPTCHA, no WAF.
- No malware scanning of audio.
- No penetration test performed.
- Transcript text is readable by anyone with database access.
- A leaked share link grants access until revoked — that is what a capability URL _is_.
