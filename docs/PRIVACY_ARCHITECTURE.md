# LiveRead — Privacy Architecture

## Principle

Two microphones, two completely different data policies. The asymmetry is
deliberate and structural, not a setting.

|                        | Creator audio                                        | Viewer audio                                        |
| ---------------------- | ---------------------------------------------------- | --------------------------------------------------- |
| Purpose                | produce the canonical transcript; optional recording | locate the reader's position in existing text       |
| Leaves the browser?    | yes (to the API → STT provider)                      | **no**                                              |
| Stored?                | only with explicit opt-in recording                  | **never**                                           |
| Retention              | creator-configured, 7 days–1 year                    | n/a — nothing exists to retain                      |
| Third-party processing | yes, when a real STT provider is configured          | none                                                |
| Consent                | explicit browser permission + preflight              | explicit browser permission + on-screen explanation |

## Viewer audio: why "never stored" is structural

Recognition runs in the browser (Web Speech API). Only the derived position is
reported:

```
POST /v1/viewer-sessions/:id   { currentWordIndex, currentSentenceIndex,
                                 alignmentState, alignmentConfidence }
```

There is **no column** in any table capable of holding viewer audio or viewer
recognized text. This is asserted by an integration test, not just documented.
When Read Aloud stops (button, or page close), tracks are stopped immediately.

See ADR-0004.

## Creator audio flow

```
mic → AudioWorklet (16 kHz PCM) → WSS → API
                                    ├→ STT provider (fake: in-process, no egress
                                    │                 deepgram: TLS to provider)
                                    └→ (opt-in) MediaRecorder chunks → S3
```

Recording is **opt-in per session**. A visible REC indicator and duration run
whenever recording is active — recording is never concealed.

## Personal data inventory

| Data                                  | Location                                   | Purpose             | Retention                                  |
| ------------------------------------- | ------------------------------------------ | ------------------- | ------------------------------------------ |
| email, display name, locale, timezone | `users`                                    | account             | until deletion; scrubbed on account delete |
| password hash (Argon2id)              | `users`                                    | auth                | until deletion                             |
| session token hash (SHA-256)          | `auth_sessions`                            | auth                | 14 days / revocation                       |
| session title, language, settings     | `live_sessions`                            | product             | retention window                           |
| transcript text                       | `transcript_segments`, `transcript_events` | product             | retention window                           |
| revision history                      | `transcript_revisions`                     | audit/correctness   | with session                               |
| recording audio                       | S3                                         | opt-in playback     | retention window                           |
| viewer reading position               | `viewer_sessions`                          | analytics/UX        | with session                               |
| hashed IP + browser family            | `share_access_events`                      | abuse defense       | with session                               |
| audit events                          | `audit_events`                             | security/compliance | with organization                          |

IP addresses are **never stored raw** — only `sha256(COOKIE_SECRET + ip)`
truncated to 32 chars. `country_code` is present in the schema but not
populated (no lawful geo-derivation configured).

## Rights

| Right                     | Mechanism                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Export                    | `GET /v1/privacy/export` → full JSON (account + sessions + transcripts)                                             |
| Delete recording          | `DELETE /v1/sessions/:id/recording` → S3 objects removed immediately                                                |
| Delete transcript/session | `DELETE /v1/sessions/:id`                                                                                           |
| Delete account            | `POST /v1/account/delete` (password-confirmed) → hard-deletes sessions and S3 objects, scrubs PII, revokes sessions |
| Revoke sharing            | `POST /v1/sessions/:id/revoke-share` → rotates id+token, ends viewer sessions                                       |
| Configure retention       | per session, 7/30/90/365 days                                                                                       |

Account deletion soft-deletes the `users` row (audit-trail integrity) but
**scrubs the PII in place**: email → `deleted-{id}@deleted.invalid`, name →
"Deleted user", password hash → `deleted`.

## Third-party disclosure

The active STT provider is shown in the creator's preflight. With
`STT_PROVIDER=fake` (the default and the demo) **no audio leaves the
deployment**. With `deepgram`, creator audio is processed by Deepgram under
their terms — see VENDOR_DATA_FLOW.md.

## Processing region

`region` is recorded per session; `S3_*`, `DATABASE_URL`, and provider endpoints
are all configurable per deployment, so a single-region-of-processing
deployment is possible today. Automatic geo-routing is not implemented.

## Logging

pino redacts cookies, authorization, passwords, and all token fields. Raw audio
is never logged. Full transcript text is not logged by default.
