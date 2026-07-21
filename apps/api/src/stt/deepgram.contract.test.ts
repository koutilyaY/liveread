import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import type { AddressInfo } from "node:net";
import { DeepgramSttProvider, deepgramLanguage } from "./deepgram.js";
import type { SttFinalResult, SttInterimResult } from "./provider.js";

/**
 * Contract tests against a local server that speaks Deepgram's documented
 * wire protocol.
 *
 * These cannot prove transcription QUALITY — only real audio against the real
 * service can do that (see `make verify-real-stt`). What they do prove is that
 * the adapter handles the protocol correctly, which is where the expensive
 * bugs live and which is otherwise completely untested without credentials.
 *
 * Protocol reference:
 * https://developers.deepgram.com/docs/understand-endpointing-interim-results
 */

interface Harness {
  provider: DeepgramSttProvider;
  url: string;
  connections: {
    headers: Record<string, string | string[] | undefined>;
    url: string;
  }[];
  received: { text: string[]; binary: number };
  send: (payload: unknown) => void;
  close: () => void;
  wss: WebSocketServer;
}

const harnesses: Harness[] = [];

async function startFakeDeepgram(): Promise<Harness> {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const port = (wss.address() as AddressInfo).port;

  const connections: Harness["connections"] = [];
  const received = { text: [] as string[], binary: 0 };
  let socket: WsSocket | null = null;

  wss.on("connection", (ws, req) => {
    socket = ws;
    connections.push({ headers: req.headers, url: req.url ?? "" });
    ws.on("message", (data, isBinary) => {
      if (isBinary) received.binary++;
      else received.text.push(data.toString());
    });
  });

  const h: Harness = {
    provider: new DeepgramSttProvider(
      "test-key",
      `ws://127.0.0.1:${port}/v1/listen`,
    ),
    url: `ws://127.0.0.1:${port}/v1/listen`,
    connections,
    received,
    send: (payload) => socket?.send(JSON.stringify(payload)),
    close: () => socket?.close(),
    wss,
  };
  harnesses.push(h);
  return h;
}

/** Build a Deepgram `Results` frame. */
function results(opts: {
  transcript: string;
  isFinal?: boolean;
  speechFinal?: boolean;
  start?: number;
  duration?: number;
  confidence?: number;
}) {
  return {
    type: "Results",
    is_final: opts.isFinal ?? false,
    speech_final: opts.speechFinal ?? false,
    start: opts.start ?? 0,
    duration: opts.duration ?? 1,
    channel: {
      alternatives: [
        { transcript: opts.transcript, confidence: opts.confidence ?? 0.95 },
      ],
    },
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    // WebSocketServer.close() waits for every client to disconnect; a test
    // that finished without closing its socket would hang the suite
    for (const client of h.wss.clients) client.terminate();
    await new Promise<void>((r) => h.wss.close(() => r()));
  }
});

describe("Deepgram adapter — connection contract", () => {
  it("authenticates with a Token header and requests interim results", async () => {
    const h = await startFakeDeepgram();
    const stream = await h.provider.startStream(
      {
        streamId: "s1",
        languageCode: "en-US",
        sampleRate: 16000,
        channelCount: 1,
        encoding: "pcm_s16le",
      },
      {
        onInterim: () => {},
        onFinal: () => {},
        onError: () => {},
        onClose: () => {},
      },
    );

    expect(h.connections).toHaveLength(1);
    expect(h.connections[0]!.headers["authorization"]).toBe("Token test-key");
    const q = new URLSearchParams(h.connections[0]!.url.split("?")[1]);
    expect(q.get("interim_results")).toBe("true");
    expect(q.get("encoding")).toBe("linear16");
    expect(q.get("sample_rate")).toBe("16000");
    expect(q.get("language")).toBe("en-US");
    // without endpointing Deepgram finalizes on a 10ms pause, shredding speech
    expect(Number(q.get("endpointing"))).toBeGreaterThanOrEqual(300);
    stream.cancelStream();
  });

  it("passes vocabulary hints as keywords", async () => {
    const h = await startFakeDeepgram();
    const stream = await h.provider.startStream(
      {
        streamId: "s1",
        languageCode: "en-US",
        sampleRate: 16000,
        channelCount: 1,
        encoding: "pcm_s16le",
        vocabulary: [{ phrase: "LiveRead", boost: 2 }],
      },
      {
        onInterim: () => {},
        onFinal: () => {},
        onError: () => {},
        onClose: () => {},
      },
    );
    const q = new URLSearchParams(h.connections[0]!.url.split("?")[1]);
    expect(q.getAll("keywords")).toContain("LiveRead:2");
    stream.cancelStream();
  });
});

describe("Deepgram adapter — utterance assembly", () => {
  it("concatenates multiple is_final chunks into ONE final segment", async () => {
    // The documented failure mode: "Long utterances may have multiple
    // is_final: true responses before speech_final: true is returned."
    // Emitting each as a final would shred one sentence into fragments.
    const h = await startFakeDeepgram();
    const finals: SttFinalResult[] = [];
    const interims: SttInterimResult[] = [];
    const stream = await h.provider.startStream(
      {
        streamId: "s1",
        languageCode: "en-US",
        sampleRate: 16000,
        channelCount: 1,
        encoding: "pcm_s16le",
      },
      {
        onInterim: (r) => interims.push(r),
        onFinal: (r) => finals.push(r),
        onError: () => {},
        onClose: () => {},
      },
    );

    h.send(results({ transcript: "my card number", isFinal: false, start: 0 }));
    h.send(
      results({
        transcript: "my card number is",
        isFinal: true,
        start: 0,
        duration: 1.2,
      }),
    );
    h.send(
      results({
        transcript: "four one two",
        isFinal: true,
        start: 1.2,
        duration: 1.0,
      }),
    );
    h.send(
      results({
        transcript: "three five six.",
        isFinal: true,
        speechFinal: true,
        start: 2.2,
        duration: 0.9,
        confidence: 0.97,
      }),
    );
    await wait(150);

    expect(finals).toHaveLength(1);
    expect(finals[0]!.text).toBe(
      "my card number is four one two three five six.",
    );
    expect(finals[0]!.confidence).toBe(0.97);
    // timestamps span the whole utterance, not just the last chunk
    expect(finals[0]!.startMs).toBe(0);
    expect(finals[0]!.endMs).toBe(3100);
    stream.cancelStream();
  });

  it("marks mid-utterance is_final chunks as STABLE interim, not final", async () => {
    const h = await startFakeDeepgram();
    const finals: SttFinalResult[] = [];
    const interims: SttInterimResult[] = [];
    const stream = await h.provider.startStream(
      {
        streamId: "s1",
        languageCode: "en-US",
        sampleRate: 16000,
        channelCount: 1,
        encoding: "pcm_s16le",
      },
      {
        onInterim: (r) => interims.push(r),
        onFinal: (r) => finals.push(r),
        onError: () => {},
        onClose: () => {},
      },
    );

    h.send(results({ transcript: "hello there", isFinal: true }));
    await wait(100);

    expect(finals).toHaveLength(0);
    expect(interims).toHaveLength(1);
    // >= 0.8 is what the transcript state machine maps to `stable_interim`
    expect(interims[0]!.stability).toBeGreaterThanOrEqual(0.8);
    stream.cancelStream();
  });

  it("shows unstable interim text appended to already-stable text", async () => {
    const h = await startFakeDeepgram();
    const interims: SttInterimResult[] = [];
    const stream = await h.provider.startStream(
      {
        streamId: "s1",
        languageCode: "en-US",
        sampleRate: 16000,
        channelCount: 1,
        encoding: "pcm_s16le",
      },
      {
        onInterim: (r) => interims.push(r),
        onFinal: () => {},
        onError: () => {},
        onClose: () => {},
      },
    );

    h.send(results({ transcript: "the first part", isFinal: true }));
    h.send(results({ transcript: "and the rest", isFinal: false }));
    await wait(100);

    const last = interims.at(-1)!;
    expect(last.text).toBe("the first part and the rest");
    expect(last.stability).toBeLessThan(0.8); // still changing
    stream.cancelStream();
  });

  it("starts a fresh utterance after speech_final", async () => {
    const h = await startFakeDeepgram();
    const finals: SttFinalResult[] = [];
    const stream = await h.provider.startStream(
      {
        streamId: "s1",
        languageCode: "en-US",
        sampleRate: 16000,
        channelCount: 1,
        encoding: "pcm_s16le",
      },
      {
        onInterim: () => {},
        onFinal: (r) => finals.push(r),
        onError: () => {},
        onClose: () => {},
      },
    );

    h.send(
      results({
        transcript: "first sentence.",
        isFinal: true,
        speechFinal: true,
      }),
    );
    h.send(
      results({
        transcript: "second sentence.",
        isFinal: true,
        speechFinal: true,
      }),
    );
    await wait(150);

    expect(finals.map((f) => f.text)).toEqual([
      "first sentence.",
      "second sentence.",
    ]);
    stream.cancelStream();
  });

  it("ignores non-Results messages and empty transcripts", async () => {
    const h = await startFakeDeepgram();
    const events: string[] = [];
    const stream = await h.provider.startStream(
      {
        streamId: "s1",
        languageCode: "en-US",
        sampleRate: 16000,
        channelCount: 1,
        encoding: "pcm_s16le",
      },
      {
        onInterim: () => events.push("interim"),
        onFinal: () => events.push("final"),
        onError: () => events.push("error"),
        onClose: () => {},
      },
    );

    h.send({ type: "Metadata", request_id: "x" });
    h.send({ type: "UtteranceEnd", last_word_end: 1.0 });
    h.send(results({ transcript: "", isFinal: true }));
    await wait(100);

    expect(events).toEqual([]);
    stream.cancelStream();
  });
});

describe("Deepgram adapter — connection lifetime", () => {
  it("sends KeepAlive text frames during silence", async () => {
    // Deepgram closes the socket after ~10s without audio (NET-0001), and a
    // creator can legitimately pause the microphone.
    const h = await startFakeDeepgram();
    const stream = await h.provider.startStream(
      {
        streamId: "s1",
        languageCode: "en-US",
        sampleRate: 16000,
        channelCount: 1,
        encoding: "pcm_s16le",
      },
      {
        onInterim: () => {},
        onFinal: () => {},
        onError: () => {},
        onClose: () => {},
      },
    );

    await wait(9_000); // longer than Deepgram's 10s budget would allow silence

    const keepAlives = h.received.text.filter(
      (m) => JSON.parse(m).type === "KeepAlive",
    );
    expect(keepAlives.length).toBeGreaterThanOrEqual(1);
    expect(h.received.binary).toBe(0);
    stream.cancelStream();
  }, 20_000);

  it("sends CloseStream on graceful finish", async () => {
    const h = await startFakeDeepgram();
    const stream = await h.provider.startStream(
      {
        streamId: "s1",
        languageCode: "en-US",
        sampleRate: 16000,
        channelCount: 1,
        encoding: "pcm_s16le",
      },
      {
        onInterim: () => {},
        onFinal: () => {},
        onError: () => {},
        onClose: () => {},
      },
    );
    await stream.finishStream();
    expect(
      h.received.text.some((m) => JSON.parse(m).type === "CloseStream"),
    ).toBe(true);
  }, 15_000);

  it("bounds the buffer when the socket drops mid-stream", async () => {
    // An unbounded queue grows ~1.9 MB/min forever once the connection is
    // gone and nothing drains it.
    const h = await startFakeDeepgram();
    const stream = await h.provider.startStream(
      {
        streamId: "s1",
        languageCode: "en-US",
        sampleRate: 16000,
        channelCount: 1,
        encoding: "pcm_s16le",
      },
      {
        onInterim: () => {},
        onFinal: () => {},
        onError: () => {},
        onClose: () => {},
      },
    );

    h.close();
    await wait(200);

    const frame = Buffer.alloc(3200);
    for (let i = 0; i < 1000; i++) stream.sendAudioFrame(frame, i * 100);

    const stats = stream.stats?.();
    expect(stats).toBeDefined();
    expect(stats!.pendingFrames).toBeLessThanOrEqual(200);
    // the overflow is counted, not silently discarded
    expect(stats!.droppedFrames).toBeGreaterThan(700);
    stream.cancelStream();
  }, 15_000);

  it("rejects and does not leak a socket when connect times out", async () => {
    // no server listening on this port
    const provider = new DeepgramSttProvider("k", "ws://127.0.0.1:9/v1/listen");
    await expect(
      provider.startStream(
        {
          streamId: "s1",
          languageCode: "en-US",
          sampleRate: 16000,
          channelCount: 1,
          encoding: "pcm_s16le",
        },
        {
          onInterim: () => {},
          onFinal: () => {},
          onError: () => {},
          onClose: () => {},
        },
      ),
    ).rejects.toThrow();
  }, 15_000);
});

describe("deepgramLanguage", () => {
  it("keeps region-qualified codes Deepgram supports", () => {
    expect(deepgramLanguage("en-GB")).toBe("en-GB");
    expect(deepgramLanguage("zh-CN")).toBe("zh-CN");
    expect(deepgramLanguage("pt-BR")).toBe("pt-BR");
  });
  it("strips regions Deepgram does not model separately", () => {
    expect(deepgramLanguage("hi-IN")).toBe("hi");
    expect(deepgramLanguage("ar-SA")).toBe("ar");
    expect(deepgramLanguage("de-DE")).toBe("de");
  });
});
