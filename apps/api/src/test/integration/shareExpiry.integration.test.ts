import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../server.js";
import { loadEnv } from "../../env.js";
import { prisma, disconnectPrisma } from "../../lib/prisma.js";
import { closeRedis } from "../../lib/redis.js";
import { closeHub } from "../../realtime/hub.js";
import { SessionTranscriber } from "../../realtime/transcriptService.js";

/**
 * Share expiry and revocation must be enforced on EVERY read path, not only
 * at token issuance.
 *
 * A viewer token is a bearer credential handed out before expiry. If the read
 * endpoints only check revocation, an expired link keeps serving transcript
 * and recordings forever to anyone holding an old token — the expiry setting
 * would be decorative.
 */

let app: FastifyInstance;
let counter = 0;
const stamp = Date.now();

async function signup(): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: {
      email: `exp-${stamp}-${counter++}@test.local`,
      password: "expiry-pass-1",
      displayName: "Expiry Tester",
    },
  });
  const setCookie = res.headers["set-cookie"];
  const header = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
  return header.split(";")[0]!;
}

interface Ctx {
  sessionId: string;
  shareId: string;
  viewerToken: string;
}

async function setup(): Promise<Ctx> {
  const cookie = await signup();
  const created = await app.inject({
    method: "POST",
    url: "/v1/sessions",
    headers: { cookie },
    payload: { title: "Expiry Session" },
  });
  const body = created.json();
  await app.inject({
    method: "POST",
    url: `/v1/sessions/${body.id}/start`,
    headers: { cookie },
    payload: {},
  });
  const t = new SessionTranscriber(prisma(), body.id, "en-US", 0);
  await t.onFinal("Confidential transcript content.", 0.9, 0, 1000);

  const access = await app.inject({
    method: "POST",
    url: `/v1/share/${body.shareId}/access`,
    payload: { token: body.shareToken },
  });
  expect(access.statusCode).toBe(200);
  return {
    sessionId: body.id,
    shareId: body.shareId,
    viewerToken: access.json().viewerToken,
  };
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

describe("share expiry is enforced on read paths", () => {
  it("REST transcript read is refused once the share has expired", async () => {
    const ctx = await setup();

    // token works before expiry
    const before = await app.inject({
      method: "GET",
      url: `/v1/share/${ctx.shareId}/transcript?token=${ctx.viewerToken}&after=-1`,
    });
    expect(before.statusCode).toBe(200);
    expect(before.json().events.length).toBeGreaterThan(0);

    // the share window closes
    await prisma().liveSession.update({
      where: { id: ctx.sessionId },
      data: { shareExpiresAt: new Date(Date.now() - 1000) },
    });

    const after = await app.inject({
      method: "GET",
      url: `/v1/share/${ctx.shareId}/transcript?token=${ctx.viewerToken}&after=-1`,
    });
    // an old bearer token must not outlive the link it came from
    expect(after.statusCode).toBe(404);
  });

  it("recording playback URL is refused once the share has expired", async () => {
    const ctx = await setup();

    // a STORED recording must exist, or this endpoint 404s for the wrong
    // reason and the test would pass without proving anything about expiry
    await prisma().recording.create({
      data: {
        liveSessionId: ctx.sessionId,
        storageKey: `recordings/${ctx.sessionId}/final.webm`,
        mimeType: "audio/webm",
        status: "stored",
        durationMs: 1000,
        sizeBytes: BigInt(1024),
        checksum: "deadbeef",
      },
    });

    // baseline: playback is available while the link is valid
    const before = await app.inject({
      method: "GET",
      url: `/v1/share/${ctx.shareId}/recording?token=${ctx.viewerToken}`,
    });
    expect(before.statusCode).toBe(200);
    expect(before.json().url).toContain("final.webm");

    await prisma().liveSession.update({
      where: { id: ctx.sessionId },
      data: { shareExpiresAt: new Date(Date.now() - 1000) },
    });

    const after = await app.inject({
      method: "GET",
      url: `/v1/share/${ctx.shareId}/recording?token=${ctx.viewerToken}`,
    });
    expect(after.statusCode).toBe(404);
  });

  it("REST transcript read is refused after revocation", async () => {
    const ctx = await setup();
    await prisma().liveSession.update({
      where: { id: ctx.sessionId },
      data: { shareRevokedAt: new Date() },
    });
    const res = await app.inject({
      method: "GET",
      url: `/v1/share/${ctx.shareId}/transcript?token=${ctx.viewerToken}&after=-1`,
    });
    expect(res.statusCode).toBe(404);
  });
});
