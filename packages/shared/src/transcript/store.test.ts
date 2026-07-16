import { describe, expect, it } from "vitest";
import { TranscriptStore } from "./store.js";
import type { TranscriptEvent } from "../events.js";

let uuidCounter = 0;
function uuid(): string {
  uuidCounter++;
  return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
}

const SESSION = "11111111-1111-4111-8111-111111111111";

function ev(
  partial: Partial<TranscriptEvent> & { sequence_number: number },
): TranscriptEvent {
  return {
    event_id: uuid(),
    session_id: SESSION,
    segment_id: "22222222-2222-4222-8222-222222222222",
    revision_number: 0,
    event_type: "transcript.interim",
    text: "",
    language_code: "en-US",
    start_ms: 0,
    end_ms: 1000,
    is_final: false,
    stability: 0.5,
    confidence: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("TranscriptStore", () => {
  it("replaces the same interim segment instead of appending", () => {
    const store = new TranscriptStore();
    store.apply(ev({ sequence_number: 0, revision_number: 0, text: "hello" }));
    store.apply(
      ev({ sequence_number: 1, revision_number: 1, text: "hello world" }),
    );
    store.apply(
      ev({ sequence_number: 2, revision_number: 2, text: "hello world today" }),
    );
    const segments = store.ordered();
    expect(segments).toHaveLength(1);
    expect(segments[0]!.text).toBe("hello world today");
  });

  it("finalizes interim segments in place", () => {
    const store = new TranscriptStore();
    store.apply(
      ev({ sequence_number: 0, revision_number: 0, text: "hello wold" }),
    );
    store.apply(
      ev({
        sequence_number: 1,
        revision_number: 1,
        event_type: "transcript.final",
        text: "Hello world.",
        is_final: true,
        confidence: 0.95,
        stability: null,
      }),
    );
    const segments = store.ordered();
    expect(segments).toHaveLength(1);
    expect(segments[0]!.status).toBe("final");
    expect(segments[0]!.text).toBe("Hello world.");
    expect(store.finalizedText()).toBe("Hello world.");
  });

  it("ignores duplicate events by event_id", () => {
    const store = new TranscriptStore();
    const e = ev({ sequence_number: 0, text: "once" });
    expect(store.apply(e).applied).toBe(true);
    expect(store.apply(e)).toEqual({
      applied: false,
      reason: "duplicate_event",
    });
    expect(store.ordered()).toHaveLength(1);
  });

  it("ignores stale revisions", () => {
    const store = new TranscriptStore();
    store.apply(ev({ sequence_number: 0, revision_number: 2, text: "newer" }));
    store.apply(ev({ sequence_number: 1, revision_number: 1, text: "older" }));
    expect(store.ordered()[0]!.text).toBe("newer");
  });

  it("never demotes a finalized segment via a late interim", () => {
    const store = new TranscriptStore();
    store.apply(
      ev({
        sequence_number: 0,
        revision_number: 1,
        event_type: "transcript.final",
        text: "Final text.",
        is_final: true,
      }),
    );
    store.apply(
      ev({ sequence_number: 1, revision_number: 5, text: "late interim" }),
    );
    const seg = store.ordered()[0]!;
    expect(seg.status).toBe("final");
    expect(seg.text).toBe("Final text.");
  });

  it("buffers out-of-order events and applies them in sequence", () => {
    const store = new TranscriptStore();
    const segA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const segB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const r = store.apply(
      ev({ sequence_number: 1, segment_id: segB, text: "second" }),
    );
    expect(r.reason).toBe("buffered_out_of_order");
    expect(store.ordered()).toHaveLength(0);
    store.apply(ev({ sequence_number: 0, segment_id: segA, text: "first" }));
    const segments = store.ordered();
    expect(segments.map((s) => s.text)).toEqual(["first", "second"]);
  });

  it("supports corrections that preserve final ordering", () => {
    const store = new TranscriptStore();
    store.apply(
      ev({
        sequence_number: 0,
        revision_number: 0,
        event_type: "transcript.final",
        text: "The quick brwn fox.",
        is_final: true,
      }),
    );
    store.apply(
      ev({
        sequence_number: 1,
        revision_number: 1,
        event_type: "transcript.corrected",
        text: "The quick brown fox.",
        is_final: true,
      }),
    );
    const seg = store.ordered()[0]!;
    expect(seg.status).toBe("corrected");
    expect(seg.text).toBe("The quick brown fox.");
  });

  it("marks deleted segments superseded and hides them", () => {
    const store = new TranscriptStore();
    store.apply(ev({ sequence_number: 0, text: "to be removed" }));
    store.apply(
      ev({
        sequence_number: 1,
        revision_number: 1,
        event_type: "transcript.deleted",
        text: "",
      }),
    );
    expect(store.ordered()).toHaveLength(0);
  });

  it("keeps stable presentation order across many segments", () => {
    const store = new TranscriptStore();
    const ids = Array.from(
      { length: 10 },
      (_, i) => `cccccccc-cccc-4ccc-8ccc-${String(i).padStart(12, "0")}`,
    );
    ids.forEach((segment_id, i) => {
      store.apply(
        ev({
          sequence_number: i,
          segment_id,
          event_type: "transcript.final",
          is_final: true,
          text: `segment ${i}.`,
        }),
      );
    });
    expect(store.finalized().map((s) => s.text)).toEqual(
      ids.map((_, i) => `segment ${i}.`),
    );
  });

  it("fast-forwards past a persistent gap instead of stalling forever", () => {
    const store = new TranscriptStore({ maxBuffered: 3 });
    // sequence 0 never arrives
    for (let i = 1; i <= 4; i++) {
      store.apply(
        ev({
          sequence_number: i,
          segment_id: `dddddddd-dddd-4ddd-8ddd-${String(i).padStart(12, "0")}`,
          text: `seg ${i}`,
        }),
      );
    }
    expect(store.ordered().length).toBeGreaterThan(0);
  });
});
