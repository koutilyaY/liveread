# LiveRead — Vendor Data Flow

## Summary

| Vendor                | Data sent                                                     | When                                                            | Avoidable?                                  |
| --------------------- | ------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------- |
| **none (default)**    | —                                                             | `STT_PROVIDER=fake`                                             | this is the default; no audio egress at all |
| Deepgram              | creator audio (16 kHz PCM stream) + optional vocabulary hints | only when `DEEPGRAM_API_KEY` is set and `STT_PROVIDER=deepgram` | yes — omit the key                          |
| S3-compatible storage | recording audio, at rest                                      | only when the creator opts into recording                       | self-hostable (MinIO)                       |
| LiveKit               | creator audio media, in transit                               | only when `creator_audio_enabled` and LiveKit is configured     | self-hostable                               |
| SMTP provider         | email address, verification/reset links                       | signup, password reset                                          | self-hostable (Mailpit locally)             |

**Viewer audio is sent to no vendor, ever.** It never leaves the browser.

## Deepgram (optional STT)

- **Endpoint:** `wss://api.deepgram.com/v1/listen` (TLS), model `nova-2`
- **Payload:** raw 16 kHz mono PCM frames from the creator's microphone; session vocabulary hints as query keywords
- **Received:** interim/final transcript text, confidence
- **Not sent:** user identity, email, session title, viewer data, share tokens
- **Credentials:** `DEEPGRAM_API_KEY` env only — never in source, never logged (pino redacts `*.token`/`authorization`)
- **Verification status:** the adapter is written to the documented protocol but **has not been exercised against the live service** (no credentials in this environment). See LIMITATIONS.md.

A production deployment using Deepgram must execute a DPA with them and
disclose it in its own privacy policy. Audio retention/training settings are the
deploying organization's responsibility to configure at the vendor.

## Object storage

Recording chunks and the concatenated recording. Path-style S3 API — MinIO
locally, any S3-compatible provider in production. Objects are never public;
playback is via 10-minute presigned URLs. Keys are server-derived.

## LiveKit

Carries live creator audio to viewers when enabled. Transcript events never
traverse LiveKit (ADR-0001). Self-hosted in compose; LiveKit Cloud is an
option in production.

## Email

Verification and password-reset links only. Mailpit locally (no external
delivery). Any SMTP endpoint in production via `SMTP_URL`.

## Adding a vendor

Any new processor must be added to this table, to PRIVACY_ARCHITECTURE.md's
inventory, and to the deployment's privacy policy **before** it is enabled.
