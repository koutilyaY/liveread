import type { SegmentStatus, TranscriptEvent } from "../events.js";

export interface SegmentView {
  segmentId: string;
  status: SegmentStatus;
  text: string;
  revision: number;
  /** Sequence of the first event that created this segment — stable ordering key. */
  orderKey: number;
  startMs: number;
  endMs: number;
  stability: number | null;
  confidence: number | null;
  isFinal: boolean;
}

export interface ApplyResult {
  applied: boolean;
  reason:
    | "applied"
    | "duplicate_event"
    | "stale_revision"
    | "buffered_out_of_order"
    | "invalid";
}

/**
 * Idempotent, ordered materializer for the transcript event log.
 *
 * Guarantees:
 *  - the same interim segment is replaced in place, never appended;
 *  - duplicate events (by event_id) are ignored;
 *  - stale revisions never overwrite newer ones;
 *  - events arriving out of sequence are buffered briefly and applied in order;
 *  - finalized segments only change via explicit corrected/deleted events.
 *
 * Used by the web client to render live state and by server/tests to assert
 * log integrity.
 */
export class TranscriptStore {
  private segments = new Map<string, SegmentView>();
  private appliedEventIds = new Set<string>();
  private lastAppliedSequence = -1;
  private outOfOrderBuffer = new Map<number, TranscriptEvent>();
  /** How many future events we hold before force-applying (gap tolerance). */
  private readonly maxBuffered: number;

  constructor(opts?: { maxBuffered?: number }) {
    this.maxBuffered = opts?.maxBuffered ?? 64;
  }

  get lastSequence(): number {
    return this.lastAppliedSequence;
  }

  apply(event: TranscriptEvent): ApplyResult {
    if (this.appliedEventIds.has(event.event_id)) {
      return { applied: false, reason: "duplicate_event" };
    }
    if (event.sequence_number <= this.lastAppliedSequence) {
      // Already-covered sequence from replay overlap: ignore as duplicate.
      this.appliedEventIds.add(event.event_id);
      return { applied: false, reason: "duplicate_event" };
    }
    if (event.sequence_number > this.lastAppliedSequence + 1) {
      this.outOfOrderBuffer.set(event.sequence_number, event);
      if (this.outOfOrderBuffer.size > this.maxBuffered) {
        // Gap persisted too long: fast-forward to the earliest buffered event.
        this.flushFrom(Math.min(...this.outOfOrderBuffer.keys()));
      }
      return { applied: false, reason: "buffered_out_of_order" };
    }
    this.applyInOrder(event);
    this.drainBuffer();
    return { applied: true, reason: "applied" };
  }

  private drainBuffer(): void {
    let next = this.outOfOrderBuffer.get(this.lastAppliedSequence + 1);
    while (next) {
      this.outOfOrderBuffer.delete(next.sequence_number);
      this.applyInOrder(next);
      next = this.outOfOrderBuffer.get(this.lastAppliedSequence + 1);
    }
  }

  private flushFrom(sequence: number): void {
    this.lastAppliedSequence = sequence - 1;
    this.drainBuffer();
  }

  private applyInOrder(event: TranscriptEvent): void {
    this.appliedEventIds.add(event.event_id);
    this.lastAppliedSequence = event.sequence_number;

    const existing = this.segments.get(event.segment_id);
    if (existing && event.revision_number <= existing.revision) {
      return; // stale revision — never overwrite newer content
    }
    if (
      existing &&
      (existing.status === "final" || existing.status === "corrected") &&
      event.event_type === "transcript.interim"
    ) {
      return; // interim can never demote a finalized segment
    }

    switch (event.event_type) {
      case "transcript.interim": {
        const status: SegmentStatus =
          (event.stability ?? 0) >= 0.8 ? "stable_interim" : "provisional";
        this.upsert(event, status);
        break;
      }
      case "transcript.final":
        this.upsert(event, "final");
        break;
      case "transcript.corrected":
        this.upsert(event, "corrected");
        break;
      case "transcript.deleted": {
        if (existing) {
          this.segments.set(event.segment_id, {
            ...existing,
            status: "superseded",
            revision: event.revision_number,
            text: "",
          });
        }
        break;
      }
    }
  }

  private upsert(event: TranscriptEvent, status: SegmentStatus): void {
    const existing = this.segments.get(event.segment_id);
    this.segments.set(event.segment_id, {
      segmentId: event.segment_id,
      status,
      text: event.text,
      revision: event.revision_number,
      orderKey: existing?.orderKey ?? event.sequence_number,
      startMs: event.start_ms,
      endMs: event.end_ms,
      stability: event.stability,
      confidence: event.confidence,
      isFinal: status === "final" || status === "corrected",
    });
  }

  /** All non-superseded segments in stable presentation order. */
  ordered(): SegmentView[] {
    return [...this.segments.values()]
      .filter((s) => s.status !== "superseded")
      .sort((a, b) => a.orderKey - b.orderKey);
  }

  finalized(): SegmentView[] {
    return this.ordered().filter((s) => s.isFinal);
  }

  interim(): SegmentView[] {
    return this.ordered().filter((s) => !s.isFinal);
  }

  finalizedText(): string {
    return this.finalized()
      .map((s) => s.text)
      .join(" ");
  }
}
