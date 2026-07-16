import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  getLanguageProfile,
  normalizeUtterance,
  type TranscriptEvent,
} from "@liveread/shared";
import { publishToSession } from "./hub.js";
import {
  transcriptBroadcastLatency,
  transcriptFinalLatency,
  transcriptInterimLatency,
} from "../lib/metrics.js";

/**
 * Persists transcript segments/events with a per-session monotonic sequence
 * and publishes them for fan-out. All writes are transactional; the sequence
 * is allocated with an atomic UPDATE ... RETURNING so any node can safely
 * ingest for a session.
 */

export interface PersistedEvent {
  event: TranscriptEvent;
}

/** Prisma client or an interactive-transaction handle. */
type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Atomic per-session sequence allocation. `UPDATE ... RETURNING` takes a row
 * lock, so concurrent writers on any API instance serialize here and can never
 * be handed the same number.
 */
async function allocateSequenceTx(db: Db, sessionId: string): Promise<number> {
  const rows = await db.$queryRaw<{ last_sequence: number }[]>`
    UPDATE live_sessions
    SET last_sequence = last_sequence + 1
    WHERE id = ${sessionId}::uuid
    RETURNING last_sequence`;
  const row = rows[0];
  if (!row) throw new Error(`session_not_found:${sessionId}`);
  return row.last_sequence;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "P2002"
  );
}

function buildEvent(params: {
  sessionId: string;
  segmentId: string;
  sequence: number;
  revision: number;
  eventType: TranscriptEvent["event_type"];
  text: string;
  languageCode: string;
  startMs: number;
  endMs: number;
  stability: number | null;
  confidence: number | null;
}): TranscriptEvent {
  return {
    event_id: randomUUID(),
    session_id: params.sessionId,
    segment_id: params.segmentId,
    sequence_number: params.sequence,
    revision_number: params.revision,
    event_type: params.eventType,
    text: params.text,
    language_code: params.languageCode,
    start_ms: params.startMs,
    end_ms: params.endMs,
    is_final:
      params.eventType === "transcript.final" ||
      params.eventType === "transcript.corrected",
    stability: params.stability,
    confidence: params.confidence,
    created_at: new Date().toISOString(),
  };
}

/** Write the durable event row. Must share a transaction with its segment. */
async function createEventTx(db: Db, event: TranscriptEvent): Promise<void> {
  await db.transcriptEvent.create({
    data: {
      id: event.event_id,
      liveSessionId: event.session_id,
      sequenceNumber: event.sequence_number,
      segmentId: event.segment_id,
      revisionNumber: event.revision_number,
      eventType: event.event_type,
      payload: event as object,
    },
  });
}

/**
 * Fan out an already-durable event. Publishing happens strictly AFTER the
 * transaction commits: publishing from inside a transaction can broadcast an
 * event that then rolls back, and viewers would hold transcript the server
 * does not have.
 */
async function publishEvent(event: TranscriptEvent): Promise<void> {
  const t0 = process.hrtime.bigint();
  await publishToSession(event.session_id, { type: "transcript.event", event });
  transcriptBroadcastLatency.observe(
    Number(process.hrtime.bigint() - t0) / 1e9,
  );
}

/**
 * Persist a segment mutation and its event atomically, then publish.
 *
 * The segment write and the event write MUST commit together. If the event
 * write fails on its own, the segment exists but no event announces it — and
 * a viewer reconnecting and replaying the event log would silently never
 * receive that text. That is precisely the "no lost finalized transcript
 * events after acknowledged persistence" guarantee.
 */
async function commitSegmentAndEvent(
  db: PrismaClient,
  sessionId: string,
  writeSegment: (tx: Prisma.TransactionClient) => Promise<void>,
  buildWithSequence: (sequence: number) => TranscriptEvent,
): Promise<TranscriptEvent> {
  const event = await db.$transaction(async (tx) => {
    await writeSegment(tx);
    const seq = await allocateSequenceTx(tx, sessionId);
    const built = buildWithSequence(seq);
    await createEventTx(tx, built);
    return built;
  });
  await publishEvent(event);
  return event;
}

/**
 * Tracks the currently-open (interim) segment for one creator stream and
 * converts provider results into segment upserts + ordered events.
 */
export class SessionTranscriber {
  private openSegmentId: string | null = null;
  private openSegmentRevision = 0;
  private segmentCounter: number;
  private frameReceivedAt = 0;
  private lastInterimText = "";

  constructor(
    private readonly db: PrismaClient,
    private readonly sessionId: string,
    private readonly languageCode: string,
    initialSegmentCount: number,
  ) {
    this.segmentCounter = initialSegmentCount;
  }

  noteFrame(): void {
    this.frameReceivedAt = Date.now();
  }

  async onInterim(
    text: string,
    stability: number,
    startMs: number,
    endMs: number,
  ): Promise<void> {
    if (!text.trim()) return;
    if (this.frameReceivedAt) {
      transcriptInterimLatency.observe(
        (Date.now() - this.frameReceivedAt) / 1000,
      );
    }
    if (text === this.lastInterimText) return; // suppress no-op updates
    this.lastInterimText = text;

    const status = stability >= 0.8 ? "stable_interim" : "provisional";

    if (!this.openSegmentId) {
      const segmentId = randomUUID();
      const segmentIndex = this.segmentCounter;
      await commitSegmentAndEvent(
        this.db,
        this.sessionId,
        async (tx) => {
          await tx.transcriptSegment.create({
            data: {
              id: segmentId,
              liveSessionId: this.sessionId,
              segmentIndex,
              currentRevision: 0,
              status,
              text,
              normalizedText: this.normalize(text),
              languageCode: this.languageCode,
              startMs,
              endMs,
              stability,
            },
          });
        },
        (sequence) =>
          buildEvent({
            sessionId: this.sessionId,
            segmentId,
            sequence,
            revision: 0,
            eventType: "transcript.interim",
            text,
            languageCode: this.languageCode,
            startMs,
            endMs,
            stability,
            confidence: null,
          }),
      );
      // only mutate in-memory state once the write has actually committed
      this.openSegmentId = segmentId;
      this.openSegmentRevision = 0;
      this.segmentCounter++;
      return;
    }

    const segmentId = this.openSegmentId;
    const revision = this.openSegmentRevision + 1;
    await commitSegmentAndEvent(
      this.db,
      this.sessionId,
      async (tx) => {
        // interim updates the open segment IN PLACE — never appends — so a
        // sentence yields exactly one segment regardless of interim count
        await tx.transcriptSegment.update({
          where: { id: segmentId },
          data: {
            currentRevision: revision,
            status,
            text,
            normalizedText: this.normalize(text),
            endMs,
            stability,
          },
        });
      },
      (sequence) =>
        buildEvent({
          sessionId: this.sessionId,
          segmentId,
          sequence,
          revision,
          eventType: "transcript.interim",
          text,
          languageCode: this.languageCode,
          startMs,
          endMs,
          stability,
          confidence: null,
        }),
    );
    this.openSegmentRevision = revision;
  }

  async onFinal(
    text: string,
    confidence: number | null,
    startMs: number,
    endMs: number,
  ): Promise<void> {
    if (!text.trim()) return;
    if (this.frameReceivedAt) {
      transcriptFinalLatency.observe(
        (Date.now() - this.frameReceivedAt) / 1000,
      );
    }
    this.lastInterimText = "";

    const openId = this.openSegmentId;
    const segmentId = openId ?? randomUUID();
    const revision = openId ? this.openSegmentRevision + 1 : 0;
    const segmentIndex = this.segmentCounter;

    await commitSegmentAndEvent(
      this.db,
      this.sessionId,
      async (tx) => {
        if (openId) {
          // finalize the interim segment in place: same id, so viewers replace
          // rather than append, and no duplicate partial phrase is persisted
          await tx.transcriptSegment.update({
            where: { id: openId },
            data: {
              currentRevision: revision,
              status: "final",
              text,
              normalizedText: this.normalize(text),
              startMs,
              endMs,
              confidence,
              stability: null,
              finalizedAt: new Date(),
            },
          });
        } else {
          await tx.transcriptSegment.create({
            data: {
              id: segmentId,
              liveSessionId: this.sessionId,
              segmentIndex,
              currentRevision: 0,
              status: "final",
              text,
              normalizedText: this.normalize(text),
              languageCode: this.languageCode,
              startMs,
              endMs,
              confidence,
              finalizedAt: new Date(),
            },
          });
        }
      },
      (sequence) =>
        buildEvent({
          sessionId: this.sessionId,
          segmentId,
          sequence,
          revision,
          eventType: "transcript.final",
          text,
          languageCode: this.languageCode,
          startMs,
          endMs,
          stability: null,
          confidence,
        }),
    );

    if (!openId) this.segmentCounter++;
    this.openSegmentId = null;
    this.openSegmentRevision = 0;
  }

  /** Flush a dangling interim as final on stream end (never lose speech). */
  async flush(): Promise<void> {
    if (this.openSegmentId && this.lastInterimText) {
      await this.onFinal(this.lastInterimText, null, 0, 0);
    }
  }

  private normalize(text: string): string {
    return normalizeUtterance(text, getLanguageProfile(this.languageCode)).join(
      " ",
    );
  }
}

/** Creator correction of a finalized segment with optimistic concurrency. */
export async function correctSegment(params: {
  db: PrismaClient;
  sessionId: string;
  segmentId: string;
  newText: string;
  expectedRevision: number;
  actorUserId: string;
  reason?: string;
}): Promise<
  { ok: true; event: TranscriptEvent } | { ok: false; code: string }
> {
  const { db, sessionId, segmentId, newText, expectedRevision, actorUserId } =
    params;
  const segment = await db.transcriptSegment.findFirst({
    where: { id: segmentId, liveSessionId: sessionId },
  });
  if (!segment) return { ok: false, code: "segment_not_found" };
  if (segment.status !== "final" && segment.status !== "corrected") {
    return { ok: false, code: "segment_not_finalized" };
  }
  if (segment.currentRevision !== expectedRevision) {
    return { ok: false, code: "revision_conflict" };
  }
  const newRevision = segment.currentRevision + 1;
  const languageCode = segment.languageCode;
  const profile = getLanguageProfile(languageCode);

  /**
   * The revision check above is only a fast path for the common case. It is
   * NOT sufficient on its own: reading the revision and then writing is a
   * classic check-then-act race, and two tabs submitting against the same
   * revision would both pass it. The authoritative check is the conditional
   * updateMany below, which is atomic in the database — if it matches zero
   * rows, another writer won and this correction is a clean conflict.
   *
   * Everything is inside one transaction, including sequence allocation, so a
   * losing correction burns no sequence number. Viewers rely on sequence
   * contiguity to detect genuinely missing events; a rejected write must not
   * punch a permanent hole in that.
   */
  const outcome = await db
    .$transaction(async (tx) => {
      const claimed = await tx.transcriptSegment.updateMany({
        where: { id: segmentId, currentRevision: expectedRevision },
        data: {
          currentRevision: newRevision,
          status: "corrected",
          text: newText,
          normalizedText: normalizeUtterance(newText, profile).join(" "),
          correctedAt: new Date(),
        },
      });
      if (claimed.count === 0) return { conflict: true as const };

      await tx.transcriptRevision.create({
        data: {
          transcriptSegmentId: segmentId,
          revisionNumber: newRevision,
          source: "creator_edit",
          previousText: segment.text,
          newText,
          actorUserId,
          reason: params.reason ?? null,
        },
      });

      const seq = await allocateSequenceTx(tx, sessionId);
      const event = buildEvent({
        sessionId,
        segmentId,
        sequence: seq,
        revision: newRevision,
        eventType: "transcript.corrected",
        text: newText,
        languageCode,
        startMs: segment.startMs,
        endMs: segment.endMs,
        stability: null,
        confidence: segment.confidence,
      });
      // the event is written in the SAME transaction as the segment change:
      // a segment mutation with no event would be invisible to any viewer
      // replaying the event log after a reconnect
      await createEventTx(tx, event);
      return { conflict: false as const, event };
    })
    .catch((err: unknown) => {
      // a unique-constraint collision means a concurrent writer beat us
      if (isUniqueViolation(err)) return { conflict: true as const };
      throw err;
    });

  if (outcome.conflict) return { ok: false, code: "revision_conflict" };
  await publishEvent(outcome.event);
  return { ok: true, event: outcome.event };
}
