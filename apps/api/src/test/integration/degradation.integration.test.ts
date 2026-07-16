import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../server.js";
import { loadEnv } from "../../env.js";
import { prisma, disconnectPrisma } from "../../lib/prisma.js";
import { closeRedis } from "../../lib/redis.js";
import { closeHub } from "../../realtime/hub.js";
import { FakeSttProvider } from "../../stt/fake.js";
import {
  markDegraded,
  resolveDegraded,
} from "../../realtime/sessionControl.js";
import { SessionTranscriber } from "../../realtime/transcriptService.js";

/**
 * Provider-failure degradation (acceptance criterion 27) and recording
 * recovery (28), exercised against the real code paths using the fake
 * provider's deterministic failure injection.
 *
 * The invariant these protect: a provider outage must produce a VISIBLE
 * degraded state and must NEVER fabricate transcript to fill the gap.
 */

let app: FastifyInstance;
let counter = 0;
const stamp = Date.now();

async function signup(): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: {
      email: `deg-${stamp}-${counter++}@test.local`,
      password: "degradation-pass-1",
      displayName: "Degradation Tester",
    },
  });
  expect(res.statusCode).toBe(201);
  const setCookie = res.headers["set-cookie"];
  const header = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
  return header.split(";")[0]!;
}

async function liveSession(cookie: string): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: "/v1/sessions",
    headers: { cookie },
    payload: { title: "Degradation Session" },
  });
  const id = created.json().id as string;
  await app.inject({
    method: "POST",
    url: `/v1/sessions/${id}/start`,
    headers: { cookie },
    payload: {},
  });
  return id;
}

beforeAll(async () => {
  loadEnv();
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await closeHub();
  await closeRedis();
  await disconnectPrisma();
});

describe("fake provider failure injection", () => {
  it("fails to start when failMode=start", async () => {
    const provider = new FakeSttProvider({ failMode: "start" });
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
    ).rejects.toThrow(/connect_failure/);
  });

  it("errors mid-stream after the configured frame count", async () => {
    const errors: Error[] = [];
    const provider = new FakeSttProvider({
      failMode: "mid",
      failAfterFrames: 3,
    });
    const stream = await provider.startStream(
      {
        streamId: "s2",
        languageCode: "en-US",
        sampleRate: 16000,
        channelCount: 1,
        encoding: "pcm_s16le",
      },
      {
        onInterim: () => {},
        onFinal: () => {},
        onError: (e) => errors.push(e),
        onClose: () => {},
      },
    );
    const frame = Buffer.alloc(3200);
    for (let i = 0; i < 3; i++) stream.sendAudioFrame(frame, i * 100);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/stream_failure/);
    stream.cancelStream();
  });
});

describe("session degradation (acceptance criterion 27)", () => {
  it("marks the session degraded, records an incident, and never fabricates transcript", async () => {
    const cookie = await signup();
    const sessionId = await liveSession(cookie);
    const db = prisma();

    await markDegraded(
      db,
      sessionId,
      "transcription",
      "Live transcription is temporarily degraded. Audio recording continues.",
    );

    // status is visible to the creator via the API the studio polls/subscribes to
    const view = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}`,
      headers: { cookie },
    });
    expect(view.json().status).toBe("degraded");

    // an unresolved incident is persisted with a recovery action
    const incident = await db.incidentEvent.findFirst({
      where: { liveSessionId: sessionId, resolvedAt: null },
    });
    expect(incident).not.toBeNull();
    expect(incident!.component).toBe("transcription");
    expect(incident!.errorCode).toBe("provider_degraded");
    expect(incident!.recoverable).toBe(true);
    expect(incident!.message).toContain("Audio recording continues");

    // CRITICAL: degradation must not invent transcript to cover the gap
    expect(
      await db.transcriptSegment.count({ where: { liveSessionId: sessionId } }),
    ).toBe(0);
    expect(
      await db.transcriptEvent.count({ where: { liveSessionId: sessionId } }),
    ).toBe(0);

    // analytics surface the incident for post-session review
    const analytics = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/analytics`,
      headers: { cookie },
    });
    expect(analytics.json().incidents).toHaveLength(1);
  });

  it("recovers: the session returns to live and the incident resolves", async () => {
    const cookie = await signup();
    const sessionId = await liveSession(cookie);
    const db = prisma();

    await markDegraded(db, sessionId, "transcription", "degraded");
    await resolveDegraded(db, sessionId, "transcription");

    const view = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}`,
      headers: { cookie },
    });
    expect(view.json().status).toBe("live");
    expect(
      await db.incidentEvent.count({
        where: { liveSessionId: sessionId, resolvedAt: null },
      }),
    ).toBe(0);
  });

  it("transcript written before a degradation survives it (gap, not loss)", async () => {
    const cookie = await signup();
    const sessionId = await liveSession(cookie);
    const db = prisma();

    const t = new SessionTranscriber(db, sessionId, "en-US", 0);
    await t.onFinal("Text spoken before the outage.", 0.9, 0, 1500);
    await markDegraded(db, sessionId, "transcription", "degraded");

    const segments = await db.transcriptSegment.findMany({
      where: { liveSessionId: sessionId },
    });
    expect(segments).toHaveLength(1);
    expect(segments[0]!.text).toBe("Text spoken before the outage.");
    expect(segments[0]!.status).toBe("final");
  });
});

describe("recording recovery (acceptance criterion 28)", () => {
  it("keeps the recording row recoverable when transcription degrades", async () => {
    const cookie = await signup();
    const sessionId = await liveSession(cookie);
    const db = prisma();

    const begin = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/recording/begin`,
      headers: { cookie },
      payload: {},
    });
    expect(begin.statusCode).toBe(201);
    const recordingId = begin.json().recordingId as string;

    await markDegraded(db, sessionId, "transcription", "degraded");

    // recording continues independently of the transcription outage
    const recording = await db.recording.findUnique({
      where: { id: recordingId },
    });
    expect(recording!.status).toBe("recording");

    // and begin is idempotent — a reconnecting creator resumes the same row
    const again = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/recording/begin`,
      headers: { cookie },
      payload: {},
    });
    expect(again.json().recordingId).toBe(recordingId);
  });
});
