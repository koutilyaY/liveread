# LiveRead — Known Limitations

Written to be believed. Everything here is a real gap, not a hedge.

## Not implemented

| #   | Gap                                                                 | Why it matters                                                                                                              | Category                                  |
| --- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 1   | **UI localization framework** not wired up (copy is inline English) | non-English users see English chrome; transcripts/alignment _are_ multilingual                                              | scope                                     |
| 2   | **RTL layout** not applied (`dir="rtl"`, mirroring)                 | Arabic text aligns correctly but the surrounding UI reads LTR                                                               | scope                                     |
| 3   | **Local Whisper provider** not implemented                          | private deployments must use the fake provider or a cloud vendor                                                            | scope                                     |
| 4   | **Second-pass batch transcription** not implemented                 | `degraded` sessions have no automatic post-hoc recovery; the pipeline hooks and revision `source` exist                     | scope                                     |
| 5   | **LiveKit live creator audio** not wired to the UI                  | viewers cannot hear the creator; compose ships LiveKit and the flags exist, but no token endpoint or publish/subscribe path | scope                                     |
| 6   | **Audio playback ↔ transcript sync** on completed sessions          | clicking a sentence does not seek the recording                                                                             | scope                                     |
| 7   | **Organization administration UI**                                  | roles/quota columns exist and are enforced server-side; no admin screens, no member management, no abuse-review tooling     | scope (spec says "minimally implemented") |
| 8   | **Terraform/OpenTofu modules**                                      | no IaC; deployment is documented but not codified                                                                           | scope                                     |
| 9   | **OTLP trace export**                                               | correlation is log-based only                                                                                               | scope                                     |
| 10  | **Malware scanning** of uploaded audio                              | documented boundary only                                                                                                    | scope                                     |
| 11  | **MFA / OAuth providers**                                           | password-only auth                                                                                                          | scope                                     |
| 12  | **Paragraph break / heading marks** during live capture             | creator cannot structure text live (can edit after)                                                                         | scope                                     |

## Implemented but unverified

| #   | Item                                   | Status                                                                                                                                                                                                                                                                                                                                         |
| --- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 13  | **Deepgram adapter**                   | protocol-verified by 13 contract tests against a local server speaking Deepgram's documented wire format; **never executed against the live service** — no credentials in this environment. Recognition quality is therefore entirely unmeasured. Run `DEEPGRAM_API_KEY=... make verify-real-stt` to close this. Blocker: missing credentials. |
| 14  | **Regional/multi-region deployment**   | designed (ADR-0011); never applied to a real cloud. Blocker: infrastructure.                                                                                                                                                                                                                                                                   |
| 15  | **Thousands of viewers per session**   | load-tested at **50 concurrent VUs on one laptop**, not thousands across regions. The Redis fan-out + DB replay design supports it; that claim is unproven at scale.                                                                                                                                                                           |
| 16  | **50,000-word auto-scroll smoothness** | alignment is verified fast on a 5,000+ word transcript (<100 ms/update). Browser scroll smoothness at 50k words is **not** measured.                                                                                                                                                                                                           |

## Product-behavior limitations (by design)

17. **Read Aloud requires the Web Speech API** — Firefox lacks it entirely; headless WebKit lacks it. Those users get the manual reading cursor, which is a complete fallback. See BROWSER_COMPATIBILITY.md.
18. **Chrome's Web Speech sends audio to a Google service.** Our code never uploads viewer audio, but the browser's own recognizer may. Deployments with strict requirements must disclose this.
19. **Reacquisition onto a near-verbatim duplicate paragraph is slow** (≤30 updates vs ≤12 elsewhere). Hysteresis deliberately prefers the nearer duplicate; instant flipping between repeated passages is the failure mode the spec forbids. Documented and asserted in the evaluation suite rather than tuned away.
20. **The fake provider does not listen.** It emits a scripted story while frames arrive. It proves the pipeline, timing, and UI — not recognition accuracy.
21. **Recognition quality is not equal across languages.** Tokenization/alignment are tested in 6 languages; recognition depends entirely on the configured provider.
22. **Backups can outlive retention.** A restored `pg_dump` can reintroduce data that `retention-cleanup` deleted. Production must bound backup retention to match and document it.
23. **Mobile background tabs suspend capture.** On return the socket reconnects and resumes from the last acknowledged frame, but audio during suspension is lost — and marked as a gap, never fabricated.
24. **Dev-mode rate limits are deliberately relaxed** (`NODE_ENV !== "production"`). Shipping with `NODE_ENV=development` would be a misconfiguration.

## Security posture caveats

25. `TRUST_PROXY` defaults to `false`. Behind a load balancer it **must** be set to the LB's addresses, or every client IP becomes the LB's and rate limiting collapses to a single bucket. Setting it to `true` on a directly-exposed API lets clients forge `X-Forwarded-For` and bypass IP rate limits entirely. (This was a real bug found by the load test; now safe-by-default and covered by tests.)
26. **No CAPTCHA/bot defense** on signup beyond rate limiting.
27. **No formal penetration test or WCAG conformance audit** by specialists.
28. **No screen-reader testing with real AT** (NVDA/JAWS/VoiceOver).

## Legal

29. **Terms of Service is an explicit placeholder** marked for qualified legal review.
30. **Minimum-age and guardian-consent policy is not configured** — required before public launch, jurisdiction-dependent.
31. **Content takedown workflow** is report-only: reports land in `incident_events` for review; no reviewer tooling or takedown action exists.
