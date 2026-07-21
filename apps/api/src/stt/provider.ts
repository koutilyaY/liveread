/**
 * Streaming speech-to-text provider abstraction.
 *
 * Implementations: FakeSttProvider (deterministic, default in dev/CI/demo),
 * DeepgramSttProvider (real streaming, credential-gated). The registry
 * wraps providers with a circuit breaker and failover (see registry.ts).
 */

export interface SttInterimResult {
  streamId: string;
  text: string;
  /** provider stability estimate 0..1 (higher = less likely to change) */
  stability: number;
  startMs: number;
  endMs: number;
}

export interface SttFinalResult {
  streamId: string;
  text: string;
  confidence: number | null;
  startMs: number;
  endMs: number;
}

export interface SttStreamCallbacks {
  onInterim: (result: SttInterimResult) => void;
  onFinal: (result: SttFinalResult) => void;
  onError: (error: Error) => void;
  onClose: () => void;
}

export interface SttStreamOptions {
  streamId: string;
  languageCode: string;
  sampleRate: number;
  channelCount: number;
  encoding: "pcm_s16le" | "opus_webm";
  vocabulary?: { phrase: string; boost: number }[];
}

export interface SttStream {
  sendAudioFrame(frame: Buffer, captureTimestampMs: number): void;
  /** Graceful end: flush pending finals then close. */
  finishStream(): Promise<void>;
  /** Abort without flushing. */
  cancelStream(): void;
  /**
   * Optional transport counters. `droppedFrames` is audio the provider could
   * not accept (socket down past the bounded buffer) — a real transcript gap,
   * which must be observable rather than silently swallowed.
   */
  stats?(): { droppedFrames: number; pendingFrames: number };
}

export interface SttUsage {
  provider: string;
  audioSecondsProcessed: number;
  streamsStarted: number;
}

export interface SttProvider {
  readonly name: string;
  startStream(
    opts: SttStreamOptions,
    cb: SttStreamCallbacks,
  ): Promise<SttStream>;
  healthCheck(): Promise<boolean>;
  supportedLanguages(): string[];
  supportsVocabularyHints(): boolean;
  supportsWordTimestamps(): boolean;
  supportsConfidence(): boolean;
  usageMetadata(): SttUsage;
}
