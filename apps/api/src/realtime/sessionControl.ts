import type { PrismaClient } from "@prisma/client";
import { publishToSession } from "./hub.js";
import { Errors } from "../lib/errors.js";

/**
 * Session lifecycle transitions, shared by REST routes and the creator socket.
 * Explicit state machine: invalid transitions raise structured errors.
 */

const TRANSITIONS: Record<string, string[]> = {
  start: ["preflight", "scheduled", "paused", "degraded"],
  pause: ["live", "degraded"],
  resume: ["paused"],
  end: ["live", "paused", "degraded", "preflight"],
};

async function transition(
  db: PrismaClient,
  sessionId: string,
  action: keyof typeof TRANSITIONS,
  toStatus: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const allowed = TRANSITIONS[action]!;
  const result = await db.liveSession.updateMany({
    where: { id: sessionId, status: { in: allowed }, deletedAt: null },
    data: { status: toStatus, ...extra },
  });
  if (result.count === 0) {
    const current = await db.liveSession.findUnique({
      where: { id: sessionId },
      select: { status: true },
    });
    throw Errors.conflict(
      `Cannot ${action} a session in status "${current?.status ?? "unknown"}".`,
    );
  }
}

export async function startSession(
  db: PrismaClient,
  sessionId: string,
): Promise<void> {
  await transition(db, sessionId, "start", "live", {
    startedAt: new Date(),
    pausedAt: null,
  });
  await publishToSession(sessionId, {
    type: "session.live",
    session_id: sessionId,
    at: new Date().toISOString(),
  });
}

export async function pauseSession(
  db: PrismaClient,
  sessionId: string,
): Promise<void> {
  await transition(db, sessionId, "pause", "paused", { pausedAt: new Date() });
  await publishToSession(sessionId, {
    type: "session.paused",
    session_id: sessionId,
    at: new Date().toISOString(),
  });
}

export async function resumeSession(
  db: PrismaClient,
  sessionId: string,
): Promise<void> {
  await transition(db, sessionId, "resume", "live", { pausedAt: null });
  await publishToSession(sessionId, {
    type: "session.resumed",
    session_id: sessionId,
    at: new Date().toISOString(),
  });
}

/**
 * Ending is two-phase: "ending" is broadcast immediately; the caller finishes
 * provider streams/flushes, then completeSession() moves to processing →
 * completed (worker finalizes the recording asynchronously).
 */
export async function beginEndingSession(
  db: PrismaClient,
  sessionId: string,
): Promise<void> {
  await transition(db, sessionId, "end", "ending", { endedAt: new Date() });
  await publishToSession(sessionId, {
    type: "session.ending",
    session_id: sessionId,
    at: new Date().toISOString(),
  });
}

export async function completeSession(
  db: PrismaClient,
  sessionId: string,
  hasRecording: boolean,
): Promise<void> {
  await db.liveSession.update({
    where: { id: sessionId },
    data: { status: hasRecording ? "processing" : "completed" },
  });
  await publishToSession(sessionId, {
    type: "session.completed",
    session_id: sessionId,
    at: new Date().toISOString(),
  });
}

export async function markDegraded(
  db: PrismaClient,
  sessionId: string,
  component: string,
  message: string,
): Promise<void> {
  await db.liveSession.updateMany({
    where: { id: sessionId, status: "live" },
    data: { status: "degraded" },
  });
  await db.incidentEvent.create({
    data: {
      liveSessionId: sessionId,
      component,
      severity: "warning",
      errorCode: "provider_degraded",
      message,
      recoverable: true,
      recoveryAction: "failover_or_post_session_recovery",
    },
  });
  await publishToSession(sessionId, {
    type: "session.degraded",
    session_id: sessionId,
    at: new Date().toISOString(),
  });
  await publishToSession(sessionId, {
    type: "incident.started",
    session_id: sessionId,
    component,
    severity: "warning",
    error_code: "provider_degraded",
    message,
    recoverable: true,
  });
}

export async function resolveDegraded(
  db: PrismaClient,
  sessionId: string,
  component: string,
): Promise<void> {
  await db.liveSession.updateMany({
    where: { id: sessionId, status: "degraded" },
    data: { status: "live" },
  });
  await db.incidentEvent.updateMany({
    where: { liveSessionId: sessionId, component, resolvedAt: null },
    data: { resolvedAt: new Date() },
  });
  await publishToSession(sessionId, {
    type: "incident.resolved",
    session_id: sessionId,
    component,
    severity: "info",
    error_code: "provider_recovered",
    message: "Live transcription recovered.",
    recoverable: true,
  });
}
