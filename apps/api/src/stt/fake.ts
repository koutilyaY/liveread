import type {
  SttProvider,
  SttStream,
  SttStreamCallbacks,
  SttStreamOptions,
  SttUsage,
} from "./provider.js";

/**
 * Deterministic fake streaming STT provider.
 *
 * Emits a scripted story word-by-word while (and only while) audio frames are
 * arriving, mimicking a real streaming recognizer: growing interim results
 * with early instability (a deliberately wrong word that later interims
 * correct), rising stability, then a punctuated final per sentence.
 *
 * Used for local dev, CI, the demo, and provider-failover fallback. It never
 * inspects audio content — pausing the microphone stops frames which stops
 * text, which is the behavior the UI needs to exercise.
 */

const DEFAULT_SCRIPT: string[] = [
  "Welcome everyone to this global reading demonstration",
  "Today we are going to explore how live text can follow your voice",
  "The words you see appear moments after they are spoken",
  "Interim text may change while a sentence is still forming",
  "Once a sentence is finalized it becomes stable and readable",
  "Viewers anywhere in the world receive these updates instantly",
  "Each reader can move through the text at their own pace",
  "The reading cursor follows your voice as you speak the words",
  "If you skip ahead the system will find your new position",
  "If you read the same sentence twice it will not lose track",
  "When you catch up with the speaker the page will tell you",
  "New sentences keep arriving while you continue reading",
  "This concludes the guided portion of the demonstration",
  "Thank you for reading along with us today",
];

// Deterministic "unstable interim" substitutions: while a sentence is being
// spoken, the Nth word is first shown wrong and corrected two words later.
const MISHEAR: Record<string, string> = {
  global: "goble",
  explore: "explode",
  finalized: "finished",
  cursor: "curse",
  demonstration: "demonstray",
};

interface FakeStreamState {
  opts: SttStreamOptions;
  cb: SttStreamCallbacks;
  sentenceIdx: number;
  wordIdx: number;
  lastFrameAt: number;
  startedAt: number;
  emittedMs: number;
  timer: NodeJS.Timeout | null;
  closed: boolean;
}

export interface FakeSttConfig {
  script?: string[];
  msPerWord?: number;
  /** frames older than this stall the script (creator paused) */
  activityWindowMs?: number;
  loopScript?: boolean;
  /**
   * Deterministic failure injection, so provider-degradation handling can be
   * tested without a real provider outage:
   *  - "start": startStream() rejects (connection failure)
   *  - "mid": the stream errors after `failAfterFrames` frames
   * Never enabled by default; set explicitly in tests or via FAKE_STT_FAIL_MODE
   * in a clearly-labeled demo/dev environment.
   */
  failMode?: "none" | "start" | "mid";
  failAfterFrames?: number;
}

export class FakeSttProvider implements SttProvider {
  readonly name = "fake";
  private script: string[];
  private msPerWord: number;
  private activityWindowMs: number;
  private loopScript: boolean;
  private failMode: "none" | "start" | "mid";
  private failAfterFrames: number;
  private usage: SttUsage = {
    provider: "fake",
    audioSecondsProcessed: 0,
    streamsStarted: 0,
  };

  constructor(config: FakeSttConfig = {}) {
    this.script = config.script ?? DEFAULT_SCRIPT;
    this.msPerWord =
      config.msPerWord ??
      (process.env["FAKE_STT_MS_PER_WORD"]
        ? Number(process.env["FAKE_STT_MS_PER_WORD"])
        : 280);
    this.activityWindowMs = config.activityWindowMs ?? 900;
    this.loopScript = config.loopScript ?? false;
    const envFail = process.env["FAKE_STT_FAIL_MODE"];
    this.failMode =
      config.failMode ??
      (envFail === "start" || envFail === "mid" ? envFail : "none");
    this.failAfterFrames = config.failAfterFrames ?? 5;
  }

  async startStream(
    opts: SttStreamOptions,
    cb: SttStreamCallbacks,
  ): Promise<SttStream> {
    this.usage.streamsStarted++;
    if (this.failMode === "start") {
      throw new Error("fake_provider_connect_failure");
    }
    const state: FakeStreamState = {
      opts,
      cb,
      sentenceIdx: 0,
      wordIdx: 0,
      lastFrameAt: 0,
      startedAt: Date.now(),
      emittedMs: 0,
      timer: null,
      closed: false,
    };

    const tick = () => {
      if (state.closed) return;
      const active = Date.now() - state.lastFrameAt < this.activityWindowMs;
      if (active) this.advance(state);
    };
    state.timer = setInterval(tick, this.msPerWord);

    let frameCount = 0;
    return {
      sendAudioFrame: (frame: Buffer, _ts: number) => {
        state.lastFrameAt = Date.now();
        this.usage.audioSecondsProcessed +=
          frame.length / (opts.sampleRate * 2 * opts.channelCount);
        frameCount++;
        if (this.failMode === "mid" && frameCount === this.failAfterFrames) {
          this.close(state);
          cb.onError(new Error("fake_provider_stream_failure"));
        }
      },
      finishStream: async () => {
        this.flushSentence(state, true);
        this.close(state);
      },
      cancelStream: () => {
        this.close(state);
      },
    };
  }

  private currentSentence(state: FakeStreamState): string[] | null {
    let idx = state.sentenceIdx;
    if (idx >= this.script.length) {
      if (!this.loopScript) return null;
      idx = idx % this.script.length;
    }
    return this.script[idx]!.split(" ");
  }

  private advance(state: FakeStreamState): void {
    const words = this.currentSentence(state);
    if (!words) return; // script exhausted; stay silent
    state.wordIdx++;
    const startMs = state.emittedMs;
    const endMs = startMs + state.wordIdx * this.msPerWord;

    if (state.wordIdx >= words.length) {
      this.flushSentence(state, false);
      return;
    }

    // interim with deterministic early mishear, corrected 2 words later
    const shown = words.slice(0, state.wordIdx).map((w, i) => {
      const misheard = MISHEAR[w.toLowerCase()];
      if (misheard && state.wordIdx - i <= 2) return misheard;
      return w;
    });
    const progress = state.wordIdx / words.length;
    state.cb.onInterim({
      streamId: state.opts.streamId,
      text: shown.join(" "),
      stability: Math.min(0.95, 0.3 + progress * 0.7),
      startMs,
      endMs,
    });
  }

  private flushSentence(state: FakeStreamState, isFlush: boolean): void {
    const words = this.currentSentence(state);
    if (!words || state.wordIdx === 0) return;
    const spoken = words.slice(0, Math.min(state.wordIdx, words.length));
    if (spoken.length === 0) return;
    const text =
      spoken.join(" ").replace(/^./, (c) => c.toUpperCase()) +
      (isFlush && state.wordIdx < words.length ? "" : ".");
    const startMs = state.emittedMs;
    const endMs = startMs + spoken.length * this.msPerWord;
    state.cb.onFinal({
      streamId: state.opts.streamId,
      text,
      confidence: 0.93,
      startMs,
      endMs,
    });
    state.emittedMs = endMs;
    state.sentenceIdx++;
    state.wordIdx = 0;
  }

  private close(state: FakeStreamState): void {
    if (state.closed) return;
    state.closed = true;
    if (state.timer) clearInterval(state.timer);
    state.cb.onClose();
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
  supportedLanguages(): string[] {
    return ["en-US", "en-GB", "es-ES", "hi-IN", "ar-SA", "zh-CN"];
  }
  supportsVocabularyHints(): boolean {
    return false;
  }
  supportsWordTimestamps(): boolean {
    return false;
  }
  supportsConfidence(): boolean {
    return true;
  }
  usageMetadata(): SttUsage {
    return { ...this.usage };
  }
}
