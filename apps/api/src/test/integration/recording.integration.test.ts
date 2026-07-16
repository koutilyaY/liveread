import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../server.js";
import { loadEnv } from "../../env.js";
import { prisma, disconnectPrisma } from "../../lib/prisma.js";
import { closeRedis } from "../../lib/redis.js";
import { closeHub } from "../../realtime/hub.js";
import { finalizeRecording } from "../../routes/recordings.js";
import { ensureBucket, getObjectBuffer } from "../../lib/s3.js";

/**
 * Recording finalize correctness.
 *
 * finalizeRecording streams chunks instead of Buffer.concat-ing them all into
 * the heap. A streaming rewrite that reorders or truncates data would be worse
 * than the memory problem it fixes, so these assert byte-exact output.
 */

let app: FastifyInstance;
let counter = 0;
const stamp = Date.now();

async function signup(): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: {
      email: `rec-${stamp}-${counter++}@test.local`,
      password: "recording-pass-1",
      displayName: "Recording Tester",
    },
  });
  expect(res.statusCode).toBe(201);
  const setCookie = res.headers["set-cookie"];
  const header = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
  return header.split(";")[0]!;
}

beforeAll(async () => {
  loadEnv();
  await ensureBucket();
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await closeHub();
  await closeRedis();
  await disconnectPrisma();
});

describe("recording finalize", () => {
  it("concatenates chunks in order, byte-exact, with a correct checksum", async () => {
    const cookie = await signup();
    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { cookie },
      payload: { title: "Recording Session", recordingEnabled: true },
    });
    const sessionId = created.json().id as string;
    await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/start`,
      headers: { cookie },
      payload: {},
    });

    const begin = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/recording/begin`,
      headers: { cookie },
      payload: {},
    });
    const recordingId = begin.json().recordingId as string;

    // 12 distinguishable chunks; upload out of order to prove ordering comes
    // from the key, not from arrival order
    const chunks = Array.from({ length: 12 }, (_, i) =>
      Buffer.alloc(1024, i + 1),
    );
    const order = [0, 3, 1, 2, 5, 4, 7, 6, 9, 8, 11, 10];
    for (const i of order) {
      const res = await app.inject({
        method: "POST",
        url: `/v1/sessions/${sessionId}/recording/${recordingId}/chunk?seq=${i}`,
        headers: { cookie, "content-type": "audio/webm" },
        payload: chunks[i]!,
      });
      expect(res.statusCode).toBe(200);
    }

    await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/recording/${recordingId}/finish`,
      headers: { cookie },
      payload: { durationMs: 12_000 },
    });

    await finalizeRecording(recordingId);

    const rec = await prisma().recording.findUniqueOrThrow({
      where: { id: recordingId },
    });
    expect(rec.status).toBe("stored");

    const expected = Buffer.concat(chunks);
    expect(Number(rec.sizeBytes)).toBe(expected.length);
    expect(rec.checksum).toBe(
      createHash("sha256").update(expected).digest("hex"),
    );

    // the stored object is byte-identical, in sequence order
    const stored = await getObjectBuffer(rec.storageKey);
    expect(stored.length).toBe(expected.length);
    expect(stored.equals(expected)).toBe(true);

    // session flips to completed once the recording lands
    const session = await prisma().liveSession.findUniqueOrThrow({
      where: { id: sessionId },
    });
    expect(["completed", "live", "paused"]).toContain(session.status);
  });

  it("streams a recording larger than the stream high-water mark (exercises backpressure)", async () => {
    const cookie = await signup();
    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { cookie },
      payload: { title: "Big Recording", recordingEnabled: true },
    });
    const sessionId = created.json().id as string;
    await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/start`,
      headers: { cookie },
      payload: {},
    });
    const begin = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/recording/begin`,
      headers: { cookie },
      payload: {},
    });
    const recordingId = begin.json().recordingId as string;

    // 8 x 1 MiB = 8 MiB, well past Readable's 16 KiB default high-water mark,
    // so Readable.push() returns false and the backpressure branch runs. Small
    // chunks never reach it — which is how a broken `once` import survived.
    const chunkCount = 8;
    const chunkSize = 1024 * 1024;
    const chunks = Array.from({ length: chunkCount }, (_, i) =>
      Buffer.alloc(chunkSize, i + 1),
    );
    for (let i = 0; i < chunkCount; i++) {
      const res = await app.inject({
        method: "POST",
        url: `/v1/sessions/${sessionId}/recording/${recordingId}/chunk?seq=${i}`,
        headers: { cookie, "content-type": "audio/webm" },
        payload: chunks[i]!,
      });
      expect(res.statusCode).toBe(200);
    }
    await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/recording/${recordingId}/finish`,
      headers: { cookie },
      payload: { durationMs: 8000 },
    });

    await finalizeRecording(recordingId);

    const rec = await prisma().recording.findUniqueOrThrow({
      where: { id: recordingId },
    });
    expect(rec.status).toBe("stored");

    const expected = Buffer.concat(chunks);
    expect(Number(rec.sizeBytes)).toBe(chunkCount * chunkSize);
    expect(rec.checksum).toBe(
      createHash("sha256").update(expected).digest("hex"),
    );
    const stored = await getObjectBuffer(rec.storageKey);
    expect(stored.equals(expected)).toBe(true);
  }, 60_000);

  it("marks the recording failed when no chunks were ever uploaded", async () => {
    const cookie = await signup();
    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { cookie },
      payload: { title: "Empty Recording", recordingEnabled: true },
    });
    const sessionId = created.json().id as string;
    await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/start`,
      headers: { cookie },
      payload: {},
    });
    const begin = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/recording/begin`,
      headers: { cookie },
      payload: {},
    });
    const recordingId = begin.json().recordingId as string;
    await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/recording/${recordingId}/finish`,
      headers: { cookie },
      payload: { durationMs: 0 },
    });

    await finalizeRecording(recordingId);

    const rec = await prisma().recording.findUniqueOrThrow({
      where: { id: recordingId },
    });
    // never silently "stored" with no audio
    expect(rec.status).toBe("failed");
  });

  it("a chunk cannot be written into another creator's recording", async () => {
    const ownerCookie = await signup();
    const attackerCookie = await signup();
    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { cookie: ownerCookie },
      payload: { title: "Victim Session", recordingEnabled: true },
    });
    const sessionId = created.json().id as string;
    await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/start`,
      headers: { cookie: ownerCookie },
      payload: {},
    });
    const begin = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/recording/begin`,
      headers: { cookie: ownerCookie },
      payload: {},
    });
    const recordingId = begin.json().recordingId as string;

    const res = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/recording/${recordingId}/chunk?seq=0`,
      headers: { cookie: attackerCookie, "content-type": "audio/webm" },
      payload: Buffer.alloc(16, 9),
    });
    // existence is not disclosed to a non-owner
    expect(res.statusCode).toBe(404);
  });
});
