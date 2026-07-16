# LiveRead — Browser Compatibility

Feature **detection** is used everywhere (`webSpeechSupported()`,
`MediaRecorder.isTypeSupported()`, `AudioWorklet` presence). There is no
user-agent sniffing anywhere in the codebase.

## Matrix

| Capability                               | Chrome/Edge      | Firefox          | Safari / iOS Safari                 | Chrome Android        |
| ---------------------------------------- | ---------------- | ---------------- | ----------------------------------- | --------------------- |
| Creator mic capture (`getUserMedia`)     | ✅               | ✅               | ✅                                  | ✅                    |
| AudioWorklet PCM framing                 | ✅               | ✅               | ✅                                  | ✅                    |
| MediaRecorder — `audio/webm;codecs=opus` | ✅               | ✅               | ❌                                  | ✅                    |
| MediaRecorder — `audio/mp4` fallback     | —                | —                | ✅ (Safari 14.1+)                   | —                     |
| **Viewer Read Aloud** (Web Speech API)   | ✅               | ❌               | ⚠️ Safari only, not headless WebKit | ✅                    |
| Manual reading cursor (no mic)           | ✅               | ✅               | ✅                                  | ✅                    |
| Transcript viewing / live updates (WS)   | ✅               | ✅               | ✅                                  | ✅                    |
| WebRTC (live creator audio via LiveKit)  | ✅               | ✅               | ✅                                  | ✅                    |
| Autoplay of creator audio                | requires gesture | requires gesture | requires gesture                    | requires gesture      |
| Background-tab behavior                  | throttled timers | throttled timers | aggressive suspension               | aggressive suspension |

## Honest statements

- **Read Aloud voice-following requires the Web Speech API.** Chromium-family browsers have it. **Firefox does not.** Safari has it, but the WebKit build Playwright ships does not. Where it is absent, the viewer sees: _"Voice following is not supported in this browser. You can still read the transcript and move the cursor by tapping a sentence."_ — and manual reading is a **complete** fallback, not a stub.
- Chrome's Web Speech implementation sends audio to a Google service for recognition. That is a browser behavior outside our control; our own code never uploads viewer audio. Deployments with strict requirements should disclose this.
- Safari cannot record `webm`. `pickRecorderMimeType()` negotiates `audio/mp4`; if nothing is supported, recording is disabled and the creator is told, rather than failing silently.
- Mobile browsers suspend background tabs aggressively. A creator who backgrounds the tab may stop streaming; on return the socket reconnects with backoff and resumes from the last acknowledged frame.

## Verified E2E results (this machine, 2026-07-15)

`npx playwright test` — **9/9 passed** across all three engines:

| Test                                            | Chromium | Firefox | WebKit |
| ----------------------------------------------- | -------- | ------- | ------ |
| creator + viewer full live flow with read-aloud | ✅       | ✅      | ✅     |
| viewer reconnect replays without duplicates     | ✅       | ✅      | ✅     |
| denied microphone → manual fallback             | ✅       | ✅      | ✅     |

**Documented test-harness notes (not product limitations):**

1. Chromium's `--use-fake-device-for-media-capture` hangs on this macOS host, so all three browsers use a **synthetic microphone fixture** that replaces `MediaDevices.prototype.getUserMedia` with a real oscillator-backed `MediaStream`. Everything downstream — AudioWorklet capture, framing, MediaRecorder, permission UX — runs the real production code path.
2. The fixture patches `MediaDevices.prototype`, not the instance: WebKit recreates the `navigator.mediaDevices` wrapper across navigations, which silently drops instance-level overrides.
3. Firefox rejects `browser.newContext({ permissions: ["microphone"] })` — Playwright has no grantable microphone permission there. The fixture makes the grant unnecessary.
4. Viewer speech uses the deterministic fake recognition driver (`?fakespeech=1`), so the read-aloud assertions run identically in engines that lack Web Speech. This tests the alignment engine and UI, **not** the browsers' own recognizers.

## Graceful degradation

| Missing capability          | Behavior                                                  |
| --------------------------- | --------------------------------------------------------- |
| Web Speech API              | manual reading cursor; explicit explanation               |
| Microphone denied (viewer)  | manual cursor + recovery instructions; position preserved |
| Microphone denied (creator) | preflight blocks Start with actionable guidance           |
| MediaRecorder unsupported   | recording disabled, transcription unaffected              |
| Recording upload fails      | emergency local download offered                          |
| Creator audio unavailable   | transcript-only viewing                                   |
| WebSocket drops             | exponential backoff + jitter, replay from last sequence   |
