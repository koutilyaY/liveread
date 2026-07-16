# LiveRead — Speech Providers

## Interface

`apps/api/src/stt/provider.ts`

```ts
interface SttProvider {
  name: string;
  startStream(opts, callbacks): Promise<SttStream>; // → sendAudioFrame / finishStream / cancelStream
  healthCheck(): Promise<boolean>;
  supportedLanguages(): string[];
  supportsVocabularyHints(): boolean;
  supportsWordTimestamps(): boolean;
  supportsConfidence(): boolean;
  usageMetadata(): SttUsage; // provider-minute accounting
}
```

Callbacks: `onInterim`, `onFinal`, `onError`, `onClose`.

## Implementations

| Provider      | Status                                                                  | Credentials        | Used by                          |
| ------------- | ----------------------------------------------------------------------- | ------------------ | -------------------------------- |
| `fake`        | complete, deterministic                                                 | none               | dev, CI, demo, failover fallback |
| `deepgram`    | complete streaming adapter (`wss://api.deepgram.com/v1/listen`, nova-2) | `DEEPGRAM_API_KEY` | opt-in production                |
| local Whisper | **not implemented** — documented adapter boundary only                  | —                  | see LIMITATIONS.md               |

### Fake provider

`apps/api/src/stt/fake.ts`. Emits a scripted story word-by-word **only while
audio frames are arriving**, so pausing the mic genuinely stops text. It
reproduces real streaming behavior the UI must handle:

- growing interim results with rising stability (0.3 → 0.95)
- a deliberate early mishear that later interims correct (`global` → `goble`)
- a punctuated final per sentence, then a fresh segment

Configurable via `FAKE_STT_MS_PER_WORD` (default 280 ms) and constructor
options (`script`, `activityWindowMs`, `loopScript`). It never inspects audio
content — it is a **fake**, not a recognizer, and is labeled as such in the UI
preflight ("Transcription provider (fake)").

### Deepgram adapter

Credential-gated: `getProvider("deepgram")` returns `null` without
`DEEPGRAM_API_KEY`, and `primaryProviderName()` honestly downgrades to `fake`
rather than pretending to be configured. No credentials are hardcoded anywhere.

To enable:

```bash
STT_PROVIDER=deepgram
STT_FALLBACK_PROVIDER=fake     # or another real provider
DEEPGRAM_API_KEY=…             # never commit this
```

**Not verified against the live Deepgram service** — no credentials were
available in this environment. The adapter is written to the documented
protocol; the code path is unexercised. See LIMITATIONS.md.

### Adding a second real provider

Implement `SttProvider`, register it in `stt/registry.ts` `getProvider()`, and
add its name to the `STT_PROVIDER` / `STT_FALLBACK_PROVIDER` enums in `env.ts`.
Nothing else changes — the transcriber, socket, and failover logic are
provider-agnostic.

## Failover & circuit breaker

`apps/api/src/stt/registry.ts`

- Per-provider circuit breaker: opens after 3 consecutive start failures, half-opens after 30 s.
- `startSttStream` tries primary → configured secondary. Failing over mid-stream happens **at most once** per creator socket.
- **No blind audio replay**: the new stream starts fresh. Audio that was in flight during the failure is not re-sent without sequence control, so the un-transcribed span is a _gap_ — it is marked, never fabricated.
- On failure (or exhausted failover) the session becomes `degraded`, an `IncidentEvent` is written, and creator + viewers see: "Live transcription is temporarily degraded. Audio recording continues."
- Recording continues throughout; a post-session recovery transcription can be scheduled against the stored audio.
- Failover never produces duplicate segments: segments are keyed by the open-segment id, and sequence allocation is atomic.

Metrics: `liveread_stt_provider_errors_total{provider,kind}`,
`liveread_stt_failovers_total{from,to}`, plus interim/final latency histograms.

## Language support

The fake provider advertises en-US/en-GB/es-ES/hi-IN/ar-SA/zh-CN; Deepgram
advertises those plus fr/de/ja. Preflight surfaces `languageSupported` for the
session's selected language.

**We do not claim equal recognition quality across languages.** Tokenization and
alignment are language-aware and tested (English, Spanish, Hindi, Arabic,
Mandarin, mixed), but recognition accuracy depends entirely on the configured
provider and the speaker.
