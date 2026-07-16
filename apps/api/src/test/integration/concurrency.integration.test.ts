import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../server.js";
import { loadEnv } from "../../env.js";
import { prisma, disconnectPrisma } from "../../lib/prisma.js";
import { closeRedis } from "../../lib/redis.js";
import { closeHub } from "../../realtime/hub.js";
import { SessionTranscriber } from "../../realtime/transcriptService.js";

/**
 * Concurrency and atomicity of transcript writes.
 *
 * These target the invariants the specification is strictest about:
 *  - optimistic concurrency must REJECT the loser cleanly (409), never 500,
 *    and never lose an update
 *  - every persisted segment change must have a corresponding event, or a
 *    reconnecting viewer replaying events would never learn about it
 *  - sequence numbers must be unique and gap-free under concurrent writers
 */

let app: FastifyInstance;
let counter = 0;
const stamp = Date.now();

async function signup(): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: {
      email: `conc-${stamp}-${counter++}@test.local`,
      password: "concurrency-pass-1",
      displayName: "Concurrency Tester",
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
    payload: { title: "Concurrency Session" },
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

describe("optimistic concurrency under a real race", () => {
  it("two simultaneous corrections: exactly one wins, the loser gets 409 (never 500)", async () => {
    const cookie = await signup();
    const sessionId = await liveSession(cookie);
    const t = new SessionTranscriber(prisma(), sessionId, "en-US", 0);
    await t.onFinal("Original text.", 0.9, 0, 1000);

    const segment = await prisma().transcriptSegment.findFirstOrThrow({
      where: { liveSessionId: sessionId },
    });
    expect(segment.currentRevision).toBe(0);

    // both tabs read revision 0 and submit at the same time
    const [a, b] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/v1/sessions/${sessionId}/segments/${segment.id}/correct`,
        headers: { cookie },
        payload: { text: "Correction A.", expectedRevision: 0 },
      }),
      app.inject({
        method: "POST",
        url: `/v1/sessions/${sessionId}/segments/${segment.id}/correct`,
        headers: { cookie },
        payload: { text: "Correction B.", expectedRevision: 0 },
      }),
    ]);

    const codes = [a.statusCode, b.statusCode].sort();
    // exactly one success, one clean conflict — no 500
    expect(codes).toEqual([200, 409]);

    // the winner's text is what persisted, at revision 1
    const after = await prisma().transcriptSegment.findFirstOrThrow({
      where: { id: segment.id },
    });
    expect(after.currentRevision).toBe(1);
    expect(["Correction A.", "Correction B."]).toContain(after.text);

    // exactly one revision row was written — no lost update, no duplicate
    const revisions = await prisma().transcriptRevision.findMany({
      where: { transcriptSegmentId: segment.id },
    });
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.newText).toBe(after.text);
  });

  it("8-way contention: exactly one winner, all losers 409, zero 500s", async () => {
    // 2 concurrent requests rarely interleave; 8 reliably do. Before the
    // conditional-update fix this produced a majority of HTTP 500s from a
    // unique-constraint violation escaping as an unhandled error.
    const cookie = await signup();
    const sessionId = await liveSession(cookie);
    const t = new SessionTranscriber(prisma(), sessionId, "en-US", 0);
    await t.onFinal("Original.", 0.9, 0, 1000);
    const segment = await prisma().transcriptSegment.findFirstOrThrow({
      where: { liveSessionId: sessionId },
    });

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        app.inject({
          method: "POST",
          url: `/v1/sessions/${sessionId}/segments/${segment.id}/correct`,
          headers: { cookie },
          payload: { text: `Correction ${i}.`, expectedRevision: 0 },
        }),
      ),
    );

    const statuses = results.map((r) => r.statusCode);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(7);
    expect(statuses.filter((s) => s >= 500)).toHaveLength(0);

    // and exactly one revision row exists — no lost update
    const revisions = await prisma().transcriptRevision.findMany({
      where: { transcriptSegmentId: segment.id },
    });
    expect(revisions).toHaveLength(1);
  });

  it("a failed correction consumes no sequence number (no permanent gap)", async () => {
    const cookie = await signup();
    const sessionId = await liveSession(cookie);
    const t = new SessionTranscriber(prisma(), sessionId, "en-US", 0);
    await t.onFinal("Some text.", 0.9, 0, 1000);

    const segment = await prisma().transcriptSegment.findFirstOrThrow({
      where: { liveSessionId: sessionId },
    });
    const before = await prisma().liveSession.findUniqueOrThrow({
      where: { id: sessionId },
      select: { lastSequence: true },
    });

    // a correction that must fail the revision check
    const res = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/segments/${segment.id}/correct`,
      headers: { cookie },
      payload: { text: "Rejected.", expectedRevision: 99 },
    });
    expect(res.statusCode).toBe(409);

    const after = await prisma().liveSession.findUniqueOrThrow({
      where: { id: sessionId },
      select: { lastSequence: true },
    });
    // a rejected write must not burn a sequence: viewers use sequence
    // contiguity to detect genuinely missing events
    expect(after.lastSequence).toBe(before.lastSequence);
  });
});

describe("segment/event atomicity", () => {
  it("every persisted segment has a corresponding transcript event", async () => {
    const cookie = await signup();
    const sessionId = await liveSession(cookie);
    const t = new SessionTranscriber(prisma(), sessionId, "en-US", 0);

    await t.onInterim("Partial one", 0.5, 0, 500);
    await t.onFinal("Sentence one.", 0.9, 0, 1000);
    await t.onInterim("Partial two", 0.5, 1000, 1500);
    await t.onFinal("Sentence two.", 0.9, 1000, 2000);

    const segments = await prisma().transcriptSegment.findMany({
      where: { liveSessionId: sessionId },
    });
    const events = await prisma().transcriptEvent.findMany({
      where: { liveSessionId: sessionId },
    });

    // a viewer replaying ONLY events must be able to reconstruct every segment
    const segmentIdsFromEvents = new Set(events.map((e) => e.segmentId));
    for (const seg of segments) {
      expect(segmentIdsFromEvents.has(seg.id)).toBe(true);
    }

    // sequences are unique and contiguous
    const seqs = events.map((e) => e.sequenceNumber).sort((a, b) => a - b);
    expect(new Set(seqs).size).toBe(seqs.length);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]! - seqs[i - 1]!).toBe(1);
    }
  });

  it("concurrent writers never collide on a sequence number", async () => {
    const cookie = await signup();
    const sessionId = await liveSession(cookie);

    // simulate independent writers racing on the same session
    const writers = Array.from(
      { length: 5 },
      (_, i) => new SessionTranscriber(prisma(), sessionId, "en-US", i * 100),
    );
    await Promise.all(
      writers.map((w, i) => w.onFinal(`Writer ${i} text.`, 0.9, 0, 100)),
    );

    const events = await prisma().transcriptEvent.findMany({
      where: { liveSessionId: sessionId },
    });
    const seqs = events.map((e) => e.sequenceNumber);
    expect(seqs.length).toBe(5);
    expect(new Set(seqs).size).toBe(5); // atomic allocation, no duplicates
  });
});
