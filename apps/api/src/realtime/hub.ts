import type { WebSocket } from "ws";
import type { Redis } from "ioredis";
import type { ServerMessage } from "@liveread/shared";
import { redis, redisSubscriber } from "../lib/redis.js";
import { wsConnections } from "../lib/metrics.js";

/**
 * Per-process socket registry with Redis pub/sub fan-out, so any number of
 * API instances can serve viewers for a session regardless of which instance
 * ingests the creator's audio.
 */

type SocketKind = "creator" | "viewer";

/** Sockets are tracked with their kind so viewers can be targeted alone. */
const localSockets = new Map<string, Map<WebSocket, SocketKind>>();
let subscriber: Redis | null = null;
const subscribedChannels = new Set<string>();

/**
 * Control frames travel on the same session channel so they reach every API
 * instance, but are consumed by the hub and never forwarded to clients.
 */
const CONTROL_DISCONNECT_VIEWERS = "__control.disconnect_viewers__";

function channelFor(sessionId: string): string {
  return `session:${sessionId}:events`;
}

async function ensureSubscriber(): Promise<Redis> {
  if (!subscriber) {
    subscriber = redisSubscriber();
    subscriber.on("message", (channel: string, message: string) => {
      const sessionId = channel.split(":")[1];
      if (!sessionId) return;
      const sockets = localSockets.get(sessionId);
      if (!sockets) return;

      if (message.startsWith(`{"__control":"`)) {
        handleControl(sessionId, message, sockets);
        return;
      }
      for (const [socket] of sockets) {
        if (socket.readyState === socket.OPEN) socket.send(message);
      }
    });
  }
  return subscriber;
}

function handleControl(
  sessionId: string,
  raw: string,
  sockets: Map<WebSocket, SocketKind>,
): void {
  let parsed: { __control?: string; code?: number; reason?: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (parsed.__control !== CONTROL_DISCONNECT_VIEWERS) return;
  for (const [socket, kind] of sockets) {
    if (kind !== "viewer") continue;
    if (socket.readyState === socket.OPEN) {
      socket.close(parsed.code ?? 4403, parsed.reason ?? "access_revoked");
    }
  }
}

/**
 * Force every viewer socket for a session to disconnect, on every instance.
 * Called when access is withdrawn (share revoked, session deleted) — an
 * already-connected viewer must not keep streaming on a stale authorization.
 */
export async function disconnectViewers(
  sessionId: string,
  reason = "access_revoked",
  code = 4403,
): Promise<void> {
  await redis().publish(
    channelFor(sessionId),
    JSON.stringify({ __control: CONTROL_DISCONNECT_VIEWERS, code, reason }),
  );
}

export async function registerSocket(
  sessionId: string,
  socket: WebSocket,
  kind: SocketKind,
): Promise<void> {
  let set = localSockets.get(sessionId);
  if (!set) {
    set = new Map();
    localSockets.set(sessionId, set);
  }
  set.set(socket, kind);
  wsConnections.inc({ kind });
  const channel = channelFor(sessionId);
  if (!subscribedChannels.has(channel)) {
    const sub = await ensureSubscriber();
    await sub.subscribe(channel);
    subscribedChannels.add(channel);
  }
}

export async function unregisterSocket(
  sessionId: string,
  socket: WebSocket,
  kind: SocketKind,
): Promise<void> {
  const set = localSockets.get(sessionId);
  if (set) {
    set.delete(socket);
    wsConnections.dec({ kind });
    if (set.size === 0) {
      localSockets.delete(sessionId);
      const channel = channelFor(sessionId);
      if (subscribedChannels.has(channel) && subscriber) {
        await subscriber.unsubscribe(channel);
        subscribedChannels.delete(channel);
      }
    }
  }
}

export async function publishToSession(
  sessionId: string,
  message: ServerMessage,
): Promise<void> {
  await redis().publish(channelFor(sessionId), JSON.stringify(message));
}

/** Viewer presence (cross-instance) with throttled count broadcast. */
const lastCountBroadcast = new Map<string, number>();

export async function viewerJoined(sessionId: string): Promise<void> {
  const count = await redis().incr(`session:${sessionId}:viewers`);
  await maybeBroadcastCount(sessionId, count);
}

export async function viewerLeft(sessionId: string): Promise<void> {
  const count = await redis().decr(`session:${sessionId}:viewers`);
  if (count < 0) await redis().set(`session:${sessionId}:viewers`, "0");
  await maybeBroadcastCount(sessionId, Math.max(0, count));
}

export async function viewerCount(sessionId: string): Promise<number> {
  const raw = await redis().get(`session:${sessionId}:viewers`);
  return raw ? Math.max(0, parseInt(raw, 10)) : 0;
}

async function maybeBroadcastCount(
  sessionId: string,
  count: number,
): Promise<void> {
  const now = Date.now();
  const last = lastCountBroadcast.get(sessionId) ?? 0;
  if (now - last < 2000) return;
  lastCountBroadcast.set(sessionId, now);
  await publishToSession(sessionId, {
    type: "viewer.count",
    session_id: sessionId,
    count,
  });
}

export async function closeHub(): Promise<void> {
  if (subscriber) {
    await subscriber.quit().catch(() => subscriber?.disconnect());
    subscriber = null;
  }
  subscribedChannels.clear();
  localSockets.clear();
}
