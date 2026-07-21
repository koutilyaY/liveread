import WebSocket from "ws";
import type {
  SttProvider,
  SttStream,
  SttStreamCallbacks,
  SttStreamOptions,
  SttUsage,
} from "./provider.js";

/**
 * Deepgram streaming adapter (wss://api.deepgram.com/v1/listen).
 *
 * Credential-gated: constructed only when DEEPGRAM_API_KEY is present.
 * CI, the demo, and default local dev never touch this path — the fake
 * provider fully exercises the pipeline.
 *
 * Protocol notes that the implementation depends on:
 *
 *  - `is_final: true` does NOT mean the utterance ended. Deepgram finalizes
 *    the transcript in segments, and a long sentence produces SEVERAL
 *    `is_final` messages that must be concatenated. `speech_final: true`
 *    marks the actual endpoint (a detected pause). Treating every `is_final`
 *    as a finished segment shreds one spoken sentence into fragments.
 *  - Deepgram closes the socket after ~10s with no audio (NET-0001). Since a
 *    creator can pause the microphone, a `{"type":"KeepAlive"}` text frame is
 *    sent during silence.
 *
 * https://developers.deepgram.com/docs/understand-endpointing-interim-results
 * https://developers.deepgram.com/docs/audio-keep-alive
 */

/** Sent during silence; Deepgram drops the connection after ~10s without it. */
const KEEPALIVE_INTERVAL_MS = 4_000;

/** Frames retained while the socket is not writable. ~20s at 100ms frames. */
const MAX_PENDING_FRAMES = 200;

/** Silence (ms) Deepgram waits before declaring an endpoint. */
const ENDPOINTING_MS = "300";

interface DeepgramResults {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  channel?: {
    alternatives?: { transcript?: string; confidence?: number }[];
  };
  start?: number;
  duration?: number;
}

export class DeepgramSttProvider implements SttProvider {
  readonly name = "deepgram";
  private usage: SttUsage = {
    provider: "deepgram",
    audioSecondsProcessed: 0,
    streamsStarted: 0,
  };

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "wss://api.deepgram.com/v1/listen",
  ) {}

  async startStream(
    opts: SttStreamOptions,
    cb: SttStreamCallbacks,
  ): Promise<SttStream> {
    this.usage.streamsStarted++;
    const params = new URLSearchParams({
      model: "nova-2",
      language: deepgramLanguage(opts.languageCode),
      encoding: opts.encoding === "pcm_s16le" ? "linear16" : "webm-opus",
      sample_rate: String(opts.sampleRate),
      channels: String(opts.channelCount),
      interim_results: "true",
      punctuate: "true",
      smart_format: "true",
      endpointing: ENDPOINTING_MS,
    });
    if (opts.vocabulary?.length) {
      for (const v of opts.vocabulary.slice(0, 100)) {
        params.append("keywords", `${v.phrase}:${v.boost}`);
      }
    }

    const ws = new WebSocket(`${this.baseUrl}?${params.toString()}`, {
      headers: { Authorization: `Token ${this.apiKey}` },
    });

    const pending: Buffer[] = [];
    let droppedFrames = 0;
    let closedByUs = false;
    let lastAudioSentAt = Date.now();

    /**
     * Finalized segments of the CURRENT utterance, awaiting `speech_final`.
     * Deepgram emits an utterance as several `is_final` chunks; the canonical
     * segment is their concatenation.
     */
    let utteranceParts: string[] = [];
    let utteranceStartMs: number | null = null;

    const writable = (): boolean => ws.readyState === WebSocket.OPEN;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        // don't leak a socket that may still connect after we gave up
        ws.terminate();
        reject(new Error("deepgram_connect_timeout"));
      }, 8000);
      ws.once("open", () => {
        clearTimeout(timeout);
        for (const buf of pending) ws.send(buf);
        pending.length = 0;
        resolve();
      });
      ws.once("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    const keepAlive = setInterval(() => {
      if (!writable()) return;
      if (Date.now() - lastAudioSentAt < KEEPALIVE_INTERVAL_MS) return;
      // must be a TEXT frame — a binary frame is treated as audio
      ws.send(JSON.stringify({ type: "KeepAlive" }));
    }, KEEPALIVE_INTERVAL_MS);

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as DeepgramResults;
        if (msg.type !== "Results") return; // Metadata, UtteranceEnd, …
        const alt = msg.channel?.alternatives?.[0];
        const text = (alt?.transcript ?? "").trim();
        const chunkStartMs = Math.round((msg.start ?? 0) * 1000);
        const chunkEndMs =
          chunkStartMs + Math.round((msg.duration ?? 0) * 1000);

        if (msg.speech_final) {
          // endpoint reached: the utterance is the concatenation of every
          // finalized chunk plus this one
          if (text) utteranceParts.push(text);
          const full = utteranceParts.join(" ").trim();
          const startMs = utteranceStartMs ?? chunkStartMs;
          utteranceParts = [];
          utteranceStartMs = null;
          if (!full) return;
          cb.onFinal({
            streamId: opts.streamId,
            text: full,
            confidence: alt?.confidence ?? null,
            startMs,
            endMs: chunkEndMs,
          });
          return;
        }

        if (!text) return;
        if (utteranceStartMs === null) utteranceStartMs = chunkStartMs;

        if (msg.is_final) {
          // finalized chunk mid-utterance: stable, but NOT the end
          utteranceParts.push(text);
          cb.onInterim({
            streamId: opts.streamId,
            text: utteranceParts.join(" ").trim(),
            // ≥0.8 maps to `stable_interim` in the transcript state machine
            stability: 0.9,
            startMs: utteranceStartMs,
            endMs: chunkEndMs,
          });
          return;
        }

        // still-changing interim: show it appended to what is already stable
        cb.onInterim({
          streamId: opts.streamId,
          text: [...utteranceParts, text].join(" ").trim(),
          stability: 0.5,
          startMs: utteranceStartMs,
          endMs: chunkEndMs,
        });
      } catch (err) {
        cb.onError(err instanceof Error ? err : new Error(String(err)));
      }
    });

    ws.on("error", (err) => {
      if (!closedByUs)
        cb.onError(err instanceof Error ? err : new Error(String(err)));
    });
    ws.on("close", () => {
      clearInterval(keepAlive);
      cb.onClose();
    });

    return {
      sendAudioFrame: (frame: Buffer) => {
        this.usage.audioSecondsProcessed +=
          frame.length / (opts.sampleRate * 2 * opts.channelCount);
        if (writable()) {
          lastAudioSentAt = Date.now();
          ws.send(frame);
          return;
        }
        // Socket not writable (connecting, or dropped mid-session). Buffer a
        // bounded window: an unbounded queue would grow ~1.9 MB/min forever
        // once the connection is gone and nothing ever drains it.
        pending.push(frame);
        while (pending.length > MAX_PENDING_FRAMES) {
          pending.shift();
          droppedFrames++;
        }
      },
      finishStream: async () => {
        closedByUs = true;
        clearInterval(keepAlive);
        if (writable()) {
          ws.send(JSON.stringify({ type: "CloseStream" }));
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 3000);
            ws.once("close", () => {
              clearTimeout(t);
              resolve();
            });
          });
        }
      },
      cancelStream: () => {
        closedByUs = true;
        clearInterval(keepAlive);
        ws.terminate();
      },
      stats: () => ({ droppedFrames, pendingFrames: pending.length }),
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch("https://api.deepgram.com/v1/projects", {
        headers: { Authorization: `Token ${this.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
  supportedLanguages(): string[] {
    return [
      "en-US",
      "en-GB",
      "es-ES",
      "hi-IN",
      "zh-CN",
      "ar-SA",
      "fr-FR",
      "de-DE",
      "ja-JP",
    ];
  }
  supportsVocabularyHints(): boolean {
    return true;
  }
  supportsWordTimestamps(): boolean {
    return true;
  }
  supportsConfidence(): boolean {
    return true;
  }
  usageMetadata(): SttUsage {
    return { ...this.usage };
  }
}

/**
 * Deepgram accepts some region-qualified codes and expects a bare language
 * for others. Blindly stripping the region loses a better-matched model
 * (en-GB), so keep the ones Deepgram documents.
 */
const REGIONAL = new Set([
  "en-US",
  "en-GB",
  "en-AU",
  "en-IN",
  "en-NZ",
  "zh-CN",
  "zh-TW",
  "pt-BR",
  "pt-PT",
  "es-419",
]);

export function deepgramLanguage(languageCode: string): string {
  if (REGIONAL.has(languageCode)) return languageCode;
  return languageCode.split("-")[0] ?? "en";
}
