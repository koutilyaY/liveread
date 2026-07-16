"use client";

/**
 * Viewer speech-recognition drivers.
 *
 * Recognition runs ENTIRELY in the browser (Web Speech API); viewer audio is
 * never uploaded or stored — only the derived reading position is reported.
 *
 * The deterministic fake driver powers E2E tests and the demo: it is enabled
 * with ?fakespeech=1 and exposes window.__lrFakeSpeech so tests can script
 * exactly what the "viewer" says.
 */

export interface RecognitionCallbacks {
  onResult: (utteranceText: string, isFinal: boolean) => void;
  onError: (code: string) => void;
  onEnd: () => void;
}

export interface RecognitionDriver {
  readonly kind: "webspeech" | "fake";
  start(lang: string, cb: RecognitionCallbacks): Promise<void>;
  stop(): void;
}

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
    length: number;
  }>;
};

function getSpeechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function webSpeechSupported(): boolean {
  return getSpeechRecognitionCtor() !== null;
}

class WebSpeechDriver implements RecognitionDriver {
  readonly kind = "webspeech" as const;
  private recognition: SpeechRecognitionLike | null = null;
  private stopped = false;

  async start(lang: string, cb: RecognitionCallbacks): Promise<void> {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      cb.onError("unsupported");
      return;
    }
    // surface the permission prompt through getUserMedia first so we can
    // release the track immediately (recognition manages its own capture)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      cb.onError("permission_denied");
      return;
    }
    this.stopped = false;
    const rec = new Ctor();
    this.recognition = rec;
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (ev) => {
      const last = ev.results[ev.results.length - 1];
      if (!last) return;
      cb.onResult(last[0].transcript, last.isFinal);
    };
    rec.onerror = (ev) => {
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
        cb.onError("permission_denied");
        this.stopped = true;
      } else if (ev.error !== "no-speech" && ev.error !== "aborted") {
        cb.onError(ev.error ?? "unknown");
      }
    };
    rec.onend = () => {
      if (!this.stopped) {
        // continuous recognition times out periodically — restart
        try {
          rec.start();
        } catch {
          cb.onEnd();
        }
      } else {
        cb.onEnd();
      }
    };
    rec.start();
  }

  stop(): void {
    this.stopped = true;
    this.recognition?.stop();
    this.recognition = null;
  }
}

/** Scriptable deterministic recognition for tests and the demo. */
export interface FakeSpeechController {
  /** emit words as one utterance: interim growth then final */
  say(words: string, opts?: { interimSteps?: boolean }): void;
  stopSpeaking(): void;
}

declare global {
  interface Window {
    __lrFakeSpeech?: FakeSpeechController;
  }
}

class FakeSpeechDriver implements RecognitionDriver {
  readonly kind = "fake" as const;
  private cb: RecognitionCallbacks | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];

  async start(_lang: string, cb: RecognitionCallbacks): Promise<void> {
    this.cb = cb;
    window.__lrFakeSpeech = {
      say: (words: string, opts) => {
        const parts = words.trim().split(/\s+/);
        if (opts?.interimSteps === false) {
          cb.onResult(words, true);
          return;
        }
        parts.forEach((_, i) => {
          const t = setTimeout(() => {
            const text = parts.slice(0, i + 1).join(" ");
            this.cb?.onResult(text, i === parts.length - 1);
          }, i * 120);
          this.timers.push(t);
        });
      },
      stopSpeaking: () => {
        this.timers.forEach(clearTimeout);
        this.timers = [];
      },
    };
  }

  stop(): void {
    this.timers.forEach(clearTimeout);
    this.timers = [];
    if (window.__lrFakeSpeech) delete window.__lrFakeSpeech;
    this.cb?.onEnd();
    this.cb = null;
  }
}

export function createRecognitionDriver(useFake: boolean): RecognitionDriver {
  return useFake ? new FakeSpeechDriver() : new WebSpeechDriver();
}
