# ADR-0009: S3-compatible object storage for recordings

**Status:** accepted

## Decision

S3-compatible storage (MinIO locally, any S3 API in production) via the AWS SDK
with `forcePathStyle`. Browser MediaRecorder chunks are uploaded sequentially as
individual objects, then concatenated and checksummed by a worker on finalize.

## Rationale

- Per-chunk objects mean an interrupted upload loses at most one chunk, and the session can resume.
- Recording bytes must never touch the database.
- Keys are server-derived (`recordings/{sessionId}/…`) — never client-supplied — so path traversal is structurally impossible.
- Playback uses short-lived presigned URLs; objects are never public.

## Consequences

- Finalization is asynchronous; the session sits in `processing` until the worker completes, then flips to `completed`.
- No cloud-specific API is used in application logic — swapping providers is configuration.
