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
 */
export class DeepgramSttProvider implements SttProvider {
  readonly name = "deepgram";
  private usage: SttUsage = {
    provider: "deepgram",
    audioSecondsProcessed: 0,
    streamsStarted: 0,
  };

  constructor(private readonly apiKey: string) {}

  async startStream(
    opts: SttStreamOptions,
    cb: SttStreamCallbacks,
  ): Promise<SttStream> {
    this.usage.streamsStarted++;
    const params = new URLSearchParams({
      model: "nova-2",
      language: opts.languageCode.split("-")[0] ?? "en",
      encoding: opts.encoding === "pcm_s16le" ? "linear16" : "webm-opus",
      sample_rate: String(opts.sampleRate),
      channels: String(opts.channelCount),
      interim_results: "true",
      punctuate: "true",
      smart_format: "true",
    });
    if (opts.vocabulary?.length) {
      for (const v of opts.vocabulary.slice(0, 100)) {
        params.append("keywords", `${v.phrase}:${v.boost}`);
      }
    }

    const ws = new WebSocket(
      `wss://api.deepgram.com/v1/listen?${params.toString()}`,
      { headers: { Authorization: `Token ${this.apiKey}` } },
    );

    let open = false;
    const pending: Buffer[] = [];
    let closedByUs = false;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("deepgram_connect_timeout")),
        8000,
      );
      ws.once("open", () => {
        clearTimeout(timeout);
        open = true;
        for (const buf of pending) ws.send(buf);
        pending.length = 0;
        resolve();
      });
      ws.once("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as {
          type?: string;
          is_final?: boolean;
          channel?: {
            alternatives?: { transcript?: string; confidence?: number }[];
          };
          start?: number;
          duration?: number;
        };
        if (msg.type !== "Results") return;
        const alt = msg.channel?.alternatives?.[0];
        const text = alt?.transcript ?? "";
        if (!text) return;
        const startMs = Math.round((msg.start ?? 0) * 1000);
        const endMs = startMs + Math.round((msg.duration ?? 0) * 1000);
        if (msg.is_final) {
          cb.onFinal({
            streamId: opts.streamId,
            text,
            confidence: alt?.confidence ?? null,
            startMs,
            endMs,
          });
        } else {
          cb.onInterim({
            streamId: opts.streamId,
            text,
            stability: 0.6,
            startMs,
            endMs,
          });
        }
      } catch (err) {
        cb.onError(err instanceof Error ? err : new Error(String(err)));
      }
    });
    ws.on("error", (err) => {
      if (!closedByUs)
        cb.onError(err instanceof Error ? err : new Error(String(err)));
    });
    ws.on("close", () => cb.onClose());

    return {
      sendAudioFrame: (frame: Buffer) => {
        this.usage.audioSecondsProcessed +=
          frame.length / (opts.sampleRate * 2 * opts.channelCount);
        if (open && ws.readyState === WebSocket.OPEN) ws.send(frame);
        else pending.push(frame);
      },
      finishStream: async () => {
        closedByUs = true;
        if (ws.readyState === WebSocket.OPEN) {
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
        ws.terminate();
      },
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
