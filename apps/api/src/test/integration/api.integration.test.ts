import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../server.js";
import { loadEnv } from "../../env.js";
import { prisma, disconnectPrisma } from "../../lib/prisma.js";
import { closeRedis } from "../../lib/redis.js";
import { closeHub } from "../../realtime/hub.js";
import { SessionTranscriber } from "../../realtime/transcriptService.js";
import { retentionCleanup } from "../../jobs/maintenance.js";

/**
 * Integration tests against the dockerized Postgres/Redis/MinIO stack
 * (docker compose up -d postgres redis minio). Each test creates its own
 * users/sessions; nothing depends on seeded data.
 */

let app: FastifyInstance;
let counter = 0;
const stamp = Date.now();

function uniqueEmail(): string {
  return `it-${stamp}-${counter++}@test.local`;
}

interface Agent {
  cookie: string;
  userId: string;
}

async function signup(displayName = "Integration User"): Promise<Agent> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: {
      email: uniqueEmail(),
      password: "integration-pass-1",
      displayName,
    },
  });
  expect(res.statusCode).toBe(201);
  const setCookie = res.headers["set-cookie"];
  const cookieHeader = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
  return {
    cookie: cookieHeader.split(";")[0]!,
    userId: res.json().id as string,
  };
}

async function createSession(
  agent: Agent,
  overrides: Record<string, unknown> = {},
): Promise<{
  id: string;
  shareId: string;
  shareToken: string;
}> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/sessions",
    headers: { cookie: agent.cookie },
    payload: { title: "Integration Session", ...overrides },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
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

describe("auth", () => {
  it("signs up, authenticates via cookie, and logs out", async () => {
    const agent = await signup();
    const me = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { cookie: agent.cookie },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().organizations).toHaveLength(1);

    const out = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { cookie: agent.cookie },
      payload: {},
    });
    expect(out.statusCode).toBe(200);
    const after = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { cookie: agent.cookie },
    });
    expect(after.statusCode).toBe(401);
  });

  it("rejects wrong passwords with a uniform error", async () => {
    const agent = await signup();
    const me = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { cookie: agent.cookie },
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: me.json().email, password: "wrong-password-1" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain("Incorrect email or password");
  });

  it("rejects mutating cross-origin requests (CSRF)", async () => {
    const agent = await signup();
    const res = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { cookie: agent.cookie, origin: "https://evil.example" },
      payload: { title: "x" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("session lifecycle", () => {
  it("creates, starts, pauses, resumes, and ends a session", async () => {
    const agent = await signup();
    const session = await createSession(agent);
    for (const [action, expected] of [
      ["start", "live"],
      ["pause", "paused"],
      ["resume", "live"],
      ["end", "completed"],
    ] as const) {
      const res = await app.inject({
        method: "POST",
        url: `/v1/sessions/${session.id}/${action}`,
        headers: { cookie: agent.cookie },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe(expected);
    }
  });

  it("rejects invalid transitions", async () => {
    const agent = await signup();
    const session = await createSession(agent);
    const res = await app.inject({
      method: "POST",
      url: `/v1/sessions/${session.id}/resume`,
      headers: { cookie: agent.cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(409);
  });
});

describe("tenant isolation", () => {
  it("hides sessions from other users entirely", async () => {
    const alice = await signup("Alice");
    const mallory = await signup("Mallory");
    const session = await createSession(alice);

    for (const [method, url] of [
      ["GET", `/v1/sessions/${session.id}`],
      ["GET", `/v1/sessions/${session.id}/transcript`],
      ["POST", `/v1/sessions/${session.id}/start`],
      ["DELETE", `/v1/sessions/${session.id}`],
      ["POST", `/v1/sessions/${session.id}/revoke-share`],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: { cookie: mallory.cookie },
        ...(method === "GET" ? {} : { payload: {} }),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    // and Mallory's listing never contains Alice's session
    const list = await app.inject({
      method: "GET",
      url: "/v1/sessions",
      headers: { cookie: mallory.cookie },
    });
    expect(
      (list.json().items as { id: string }[]).find((s) => s.id === session.id),
    ).toBeUndefined();
  });
});

describe("share access", () => {
  it("grants access with the correct token only", async () => {
    const agent = await signup();
    const session = await createSession(agent);
    const good = await app.inject({
      method: "POST",
      url: `/v1/share/${session.shareId}/access`,
      payload: { token: session.shareToken },
    });
    expect(good.statusCode).toBe(200);
    expect(good.json().viewerToken).toBeTruthy();

    const bad = await app.inject({
      method: "POST",
      url: `/v1/share/${session.shareId}/access`,
      payload: { token: "wrong-token" },
    });
    expect(bad.statusCode).toBe(404); // uniform: no oracle
    const missing = await app.inject({
      method: "POST",
      url: `/v1/share/nonexistent-share/access`,
      payload: { token: "whatever" },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("enforces passcodes", async () => {
    const agent = await signup();
    const session = await createSession(agent, {
      privacyMode: "passcode",
      passcode: "sesame42",
    });
    const noPass = await app.inject({
      method: "POST",
      url: `/v1/share/${session.shareId}/access`,
      payload: { token: session.shareToken },
    });
    expect(noPass.statusCode).toBe(400);
    expect(noPass.json().error.details.needsPasscode).toBe(true);
    const withPass = await app.inject({
      method: "POST",
      url: `/v1/share/${session.shareId}/access`,
      payload: { token: session.shareToken, passcode: "sesame42" },
    });
    expect(withPass.statusCode).toBe(200);
  });

  it("revocation invalidates existing viewer sessions and old links", async () => {
    const agent = await signup();
    const session = await createSession(agent);
    const access = await app.inject({
      method: "POST",
      url: `/v1/share/${session.shareId}/access`,
      payload: { token: session.shareToken },
    });
    const viewerToken = access.json().viewerToken as string;

    const revoke = await app.inject({
      method: "POST",
      url: `/v1/sessions/${session.id}/revoke-share`,
      headers: { cookie: agent.cookie },
      payload: {},
    });
    expect(revoke.statusCode).toBe(200);

    // old share id no longer resolves
    const oldLink = await app.inject({
      method: "POST",
      url: `/v1/share/${session.shareId}/access`,
      payload: { token: session.shareToken },
    });
    expect(oldLink.statusCode).toBe(404);

    // old viewer token no longer works for transcript reads
    const read = await app.inject({
      method: "GET",
      url: `/v1/share/${revoke.json().shareId}/transcript?token=${viewerToken}`,
    });
    expect(read.statusCode).toBe(401);
  });

  it("expired links are refused", async () => {
    const agent = await signup();
    const session = await createSession(agent);
    await prisma().liveSession.update({
      where: { id: session.id },
      data: { shareExpiresAt: new Date(Date.now() - 1000) },
    });
    const res = await app.inject({
      method: "POST",
      url: `/v1/share/${session.shareId}/access`,
      payload: { token: session.shareToken },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("transcript pipeline", () => {
  it("persists ordered events, replaces interims, and replays after a sequence", async () => {
    const agent = await signup();
    const session = await createSession(agent);
    await app.inject({
      method: "POST",
      url: `/v1/sessions/${session.id}/start`,
      headers: { cookie: agent.cookie },
      payload: {},
    });

    const t = new SessionTranscriber(prisma(), session.id, "en-US", 0);
    await t.onInterim("hello", 0.5, 0, 400);
    await t.onInterim("hello world", 0.9, 0, 900);
    await t.onFinal("Hello world.", 0.95, 0, 1000);
    await t.onInterim("second", 0.5, 1000, 1400);
    await t.onFinal("Second sentence.", 0.9, 1000, 2000);

    const events = await prisma().transcriptEvent.findMany({
      where: { liveSessionId: session.id },
      orderBy: { sequenceNumber: "asc" },
    });
    expect(events.map((e) => e.sequenceNumber)).toEqual([0, 1, 2, 3, 4]);
    expect(events.map((e) => e.eventType)).toEqual([
      "transcript.interim",
      "transcript.interim",
      "transcript.final",
      "transcript.interim",
      "transcript.final",
    ]);

    // two segments only — interims replaced in place
    const segments = await prisma().transcriptSegment.findMany({
      where: { liveSessionId: session.id },
      orderBy: { segmentIndex: "asc" },
    });
    expect(segments).toHaveLength(2);
    expect(segments.map((s) => s.status)).toEqual(["final", "final"]);
    expect(segments[0]!.text).toBe("Hello world.");

    // REST replay for viewers: only events after a known sequence
    const access = await app.inject({
      method: "POST",
      url: `/v1/share/${session.shareId}/access`,
      payload: { token: session.shareToken },
    });
    const replay = await app.inject({
      method: "GET",
      url: `/v1/share/${session.shareId}/transcript?token=${access.json().viewerToken}&after=2`,
    });
    expect(replay.statusCode).toBe(200);
    const replayed = replay.json().events as { sequence_number: number }[];
    expect(replayed.map((e) => e.sequence_number)).toEqual([3, 4]);
  });

  it("creator corrections enforce optimistic concurrency and keep history", async () => {
    const agent = await signup();
    const session = await createSession(agent);
    const t = new SessionTranscriber(prisma(), session.id, "en-US", 0);
    await t.onFinal("The quick brwn fox.", 0.9, 0, 1000);
    const segment = (await prisma().transcriptSegment.findFirst({
      where: { liveSessionId: session.id },
    }))!;

    const stale = await app.inject({
      method: "POST",
      url: `/v1/sessions/${session.id}/segments/${segment.id}/correct`,
      headers: { cookie: agent.cookie },
      payload: { text: "nope", expectedRevision: 99 },
    });
    expect(stale.statusCode).toBe(409);

    const ok = await app.inject({
      method: "POST",
      url: `/v1/sessions/${session.id}/segments/${segment.id}/correct`,
      headers: { cookie: agent.cookie },
      payload: {
        text: "The quick brown fox.",
        expectedRevision: segment.currentRevision,
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().event.event_type).toBe("transcript.corrected");

    const history = await app.inject({
      method: "GET",
      url: `/v1/sessions/${session.id}/segments/${segment.id}/revisions`,
      headers: { cookie: agent.cookie },
    });
    const revisions = history.json().revisions as {
      previousText: string;
      newText: string;
      source: string;
    }[];
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      previousText: "The quick brwn fox.",
      newText: "The quick brown fox.",
      source: "creator_edit",
    });
  });

  it("duplicate sequence numbers are impossible (unique constraint)", async () => {
    const agent = await signup();
    const session = await createSession(agent);
    const t = new SessionTranscriber(prisma(), session.id, "en-US", 0);
    await t.onFinal("Only once.", 0.9, 0, 500);
    const event = (await prisma().transcriptEvent.findFirst({
      where: { liveSessionId: session.id },
    }))!;
    await expect(
      prisma().transcriptEvent.create({
        data: {
          liveSessionId: session.id,
          sequenceNumber: event.sequenceNumber,
          segmentId: event.segmentId,
          revisionNumber: 5,
          eventType: "transcript.final",
          payload: {},
        },
      }),
    ).rejects.toThrow();
  });
});

describe("retention", () => {
  it("hard-deletes sessions past their retention window", async () => {
    const agent = await signup();
    const session = await createSession(agent, { retentionDays: 1 });
    const t = new SessionTranscriber(prisma(), session.id, "en-US", 0);
    await t.onFinal("Ephemeral.", 0.9, 0, 500);
    await prisma().liveSession.update({
      where: { id: session.id },
      data: {
        status: "completed",
        endedAt: new Date(Date.now() - 3 * 24 * 3600 * 1000),
      },
    });
    const result = await retentionCleanup();
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(
      await prisma().liveSession.findUnique({ where: { id: session.id } }),
    ).toBeNull();
    expect(
      await prisma().transcriptSegment.count({
        where: { liveSessionId: session.id },
      }),
    ).toBe(0);
  });
});

describe("viewer privacy", () => {
  it("never stores viewer audio and only accepts position updates", async () => {
    const agent = await signup();
    const session = await createSession(agent);
    const access = await app.inject({
      method: "POST",
      url: `/v1/share/${session.shareId}/access`,
      payload: { token: session.shareToken },
    });
    const { viewerSessionId, viewerToken } = access.json();
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/viewer-sessions/${viewerSessionId}`,
      payload: {
        viewerToken,
        currentWordIndex: 42,
        alignmentState: "tracking",
        alignmentConfidence: 0.9,
      },
    });
    expect(res.statusCode).toBe(200);
    const row = (await prisma().viewerSession.findUnique({
      where: { id: viewerSessionId },
    }))!;
    expect(row.currentWordIndex).toBe(42);
    // schema-level check: the viewer session model has no audio/text columns
    expect(Object.keys(row)).not.toContain("audio");
    expect(Object.keys(row)).not.toContain("recognizedText");
  });
});
