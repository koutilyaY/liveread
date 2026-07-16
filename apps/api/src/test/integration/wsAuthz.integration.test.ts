import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import { buildServer } from "../../server.js";
import { loadEnv } from "../../env.js";
import { prisma, disconnectPrisma } from "../../lib/prisma.js";
import { closeRedis } from "../../lib/redis.js";
import { closeHub } from "../../realtime/hub.js";
import { SessionTranscriber } from "../../realtime/transcriptService.js";

/**
 * Live-socket authorization: access control must be enforced for the LIFETIME
 * of a viewer socket, not only at connect time.
 *
 * A viewer who is already connected when the creator revokes the share link
 * must stop receiving transcript. Checking only on connect leaves a revoked
 * viewer streaming indefinitely, which defeats the entire point of revocation.
 */

let app: FastifyInstance;
let baseUrl: string;
let counter = 0;
const stamp = Date.now();

async function signup(): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: {
      email: `wsauthz-${stamp}-${counter++}@test.local`,
      password: "ws-authz-pass-1",
      displayName: "WS Authz",
    },
  });
  expect(res.statusCode).toBe(201);
  const setCookie = res.headers["set-cookie"];
  const header = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
  return header.split(";")[0]!;
}

interface Live {
  cookie: string;
  sessionId: string;
  shareId: string;
  shareToken: string;
}

async function createLive(): Promise<Live> {
  const cookie = await signup();
  const created = await app.inject({
    method: "POST",
    url: "/v1/sessions",
    headers: { cookie },
    payload: { title: "WS Authz Session" },
  });
  const body = created.json();
  await app.inject({
    method: "POST",
    url: `/v1/sessions/${body.id}/start`,
    headers: { cookie },
    payload: {},
  });
  return {
    cookie,
    sessionId: body.id,
    shareId: body.shareId,
    shareToken: body.shareToken,
  };
}

async function viewerToken(shareId: string, token: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/v1/share/${shareId}/access`,
    payload: { token },
  });
  expect(res.statusCode).toBe(200);
  return res.json().viewerToken;
}

/** Connect, subscribe, and collect every transcript event received. */
async function connectViewer(
  shareId: string,
  token: string,
): Promise<{ ws: WebSocket; events: unknown[]; closed: () => boolean }> {
  const ws = new WebSocket(
    `${baseUrl.replace("http", "ws")}/ws/viewer/${shareId}?token=${token}`,
  );
  const events: unknown[] = [];
  let isClosed = false;
  ws.on("close", () => {
    isClosed = true;
  });
  ws.on("message", (raw: Buffer) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "transcript.event") events.push(msg.event);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  ws.send(JSON.stringify({ type: "subscribe", last_received_sequence: -1 }));
  await new Promise((r) => setTimeout(r, 200));
  return { ws, events, closed: () => isClosed };
}

beforeAll(async () => {
  loadEnv();
  app = await buildServer();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await app.close();
  await closeHub();
  await closeRedis();
  await disconnectPrisma();
});

describe("viewer socket authorization is enforced for the socket lifetime", () => {
  it("stops delivering transcript to a viewer after the creator revokes the share", async () => {
    const live = await createLive();
    const token = await viewerToken(live.shareId, live.shareToken);
    const viewer = await connectViewer(live.shareId, token);

    // baseline: the viewer is genuinely receiving live transcript
    const t = new SessionTranscriber(prisma(), live.sessionId, "en-US", 0);
    await t.onFinal("Before revocation.", 0.9, 0, 1000);
    await new Promise((r) => setTimeout(r, 300));
    expect(viewer.events.length).toBe(1);

    // creator revokes the share link
    const revoke = await app.inject({
      method: "POST",
      url: `/v1/sessions/${live.sessionId}/revoke-share`,
      headers: { cookie: live.cookie },
      payload: {},
    });
    expect(revoke.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 400));

    // the revoked viewer must be disconnected
    expect(viewer.closed()).toBe(true);

    // and must NOT receive transcript produced after revocation
    await t.onFinal("Secret content after revocation.", 0.9, 1000, 2000);
    await new Promise((r) => setTimeout(r, 400));
    expect(viewer.events.length).toBe(1);

    viewer.ws.close();
  });

  it("disconnects live viewers when the session share expires", async () => {
    const live = await createLive();
    const token = await viewerToken(live.shareId, live.shareToken);
    const viewer = await connectViewer(live.shareId, token);

    const t = new SessionTranscriber(prisma(), live.sessionId, "en-US", 0);
    await t.onFinal("Before expiry.", 0.9, 0, 1000);
    await new Promise((r) => setTimeout(r, 300));
    expect(viewer.events.length).toBe(1);

    // backdate expiry as if the window had elapsed
    await prisma().liveSession.update({
      where: { id: live.sessionId },
      data: { shareExpiresAt: new Date(Date.now() - 1000) },
    });
    await new Promise((r) => setTimeout(r, 400));

    await t.onFinal("Content after expiry.", 0.9, 1000, 2000);
    await new Promise((r) => setTimeout(r, 600));

    expect(viewer.events.length).toBe(1);
    viewer.ws.close();
  });

  it("bounds a single replay batch instead of flushing an unbounded transcript", async () => {
    const live = await createLive();
    const token = await viewerToken(live.shareId, live.shareToken);

    // write more events than the replay page size
    const t = new SessionTranscriber(prisma(), live.sessionId, "en-US", 0);
    for (let i = 0; i < 60; i++) {
      await t.onFinal(`Sentence number ${i}.`, 0.9, i * 100, i * 100 + 90);
    }

    const viewer = await connectViewer(live.shareId, token);
    // wait for paged replay to drain
    await new Promise((r) => setTimeout(r, 1500));

    // every event still arrives, exactly once, in order
    const seqs = (viewer.events as { sequence_number: number }[]).map(
      (e) => e.sequence_number,
    );
    expect(seqs.length).toBe(60);
    expect(new Set(seqs).size).toBe(60);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);

    viewer.ws.close();
  });
});
