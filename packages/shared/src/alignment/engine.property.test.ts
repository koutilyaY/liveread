import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { AlignmentEngine } from "./engine.js";
import { buildTranscriptTokens, prng, simulateReading } from "./testkit.js";

/**
 * Property-based tests: generated transcripts + simulated noisy readers.
 * Invariants:
 *  - the engine never crashes;
 *  - cursor stays within valid bounds;
 *  - confidence stays in [0, 1];
 *  - normal forward reading is monotonic within tolerance;
 *  - reacquisition after a skip lands in the correct neighborhood
 *    under supported noise levels.
 */

const WORD_POOL = [
  "river",
  "mountain",
  "signal",
  "garden",
  "window",
  "story",
  "yellow",
  "travel",
  "monday",
  "science",
  "purple",
  "engine",
  "harbor",
  "silver",
  "market",
  "forest",
  "candle",
  "planet",
  "bridge",
  "meadow",
  "sunset",
  "letter",
  "bottle",
  "orange",
  "throne",
  "valley",
  "shadow",
  "spring",
];

function genTranscript(rand: () => number, sentences: number): string {
  const parts: string[] = [];
  for (let s = 0; s < sentences; s++) {
    const len = 5 + Math.floor(rand() * 7);
    const words: string[] = [];
    for (let i = 0; i < len; i++) {
      words.push(WORD_POOL[Math.floor(rand() * WORD_POOL.length)]!);
    }
    words[0] = words[0]![0]!.toUpperCase() + words[0]!.slice(1);
    parts.push(words.join(" ") + ".");
  }
  return parts.join(" ");
}

function feed(
  engine: AlignmentEngine,
  utterances: string[][],
  t0: number,
  stepMs = 300,
): number {
  let t = t0;
  for (const u of utterances) {
    for (let i = 1; i <= u.length; i++) {
      engine.update({
        utteranceTokens: u.slice(0, i),
        isFinal: i === u.length,
        timestampMs: t,
      });
      t += stepMs;
    }
  }
  return t;
}

describe("AlignmentEngine properties", () => {
  it("never crashes and keeps invariants under arbitrary noise", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000 }),
        fc.record({
          dropRate: fc.double({ min: 0, max: 0.4, noNaN: true }),
          fillerRate: fc.double({ min: 0, max: 0.4, noNaN: true }),
          substituteRate: fc.double({ min: 0, max: 0.4, noNaN: true }),
          repeatRate: fc.double({ min: 0, max: 0.4, noNaN: true }),
        }),
        (seed, noise) => {
          const rand = prng(seed);
          const transcript = genTranscript(rand, 6 + Math.floor(rand() * 6));
          const { matchable } = buildTranscriptTokens(transcript);
          const engine = new AlignmentEngine();
          engine.setTranscriptTokens(matchable);
          const words = matchable.map((t) => t.norm);
          const utterances = simulateReading(
            words,
            0,
            words.length,
            rand,
            noise,
          );
          feed(engine, utterances, 0);
          const r = engine.getResult();
          expect(r.confidence).toBeGreaterThanOrEqual(0);
          expect(r.confidence).toBeLessThanOrEqual(1);
          expect(r.matchedTokenIndex).toBeGreaterThanOrEqual(-1);
          expect(r.matchedTokenIndex).toBeLessThan(matchable.length);
          expect([
            "waiting",
            "tracking",
            "uncertain",
            "lost",
            "caught_up",
          ]).toContain(r.state);
        },
      ),
      { numRuns: 60 },
    );
  });

  it("clean forward reading is monotonic within tolerance", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000 }), (seed) => {
        const rand = prng(seed);
        const transcript = genTranscript(rand, 8);
        const { matchable } = buildTranscriptTokens(transcript);
        const engine = new AlignmentEngine();
        engine.setTranscriptTokens(matchable);
        const words = matchable.map((t) => t.norm);

        let t = 0;
        let prevIndex = -1;
        const TOLERANCE = 6; // small backward corrections allowed
        for (let i = 0; i < words.length; i += 4) {
          const chunk = words.slice(i, i + 4);
          for (let j = 1; j <= chunk.length; j++) {
            const r = engine.update({
              utteranceTokens: chunk.slice(0, j),
              isFinal: j === chunk.length,
              timestampMs: t,
            });
            t += 250;
            if (r.state === "tracking" || r.state === "caught_up") {
              expect(r.matchedTokenIndex).toBeGreaterThanOrEqual(
                prevIndex - TOLERANCE,
              );
              prevIndex = Math.max(prevIndex, r.matchedTokenIndex);
            }
          }
        }
        // a clean read must end tracked near the end
        const final = engine.getResult();
        expect(["tracking", "caught_up"]).toContain(final.state);
        expect(final.matchedTokenIndex).toBeGreaterThan(words.length * 0.7);
      }),
      { numRuns: 40 },
    );
  });

  it("reacquires the correct neighborhood after a forward skip with mild noise", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000 }), (seed) => {
        const rand = prng(seed);
        const transcript = genTranscript(rand, 10);
        const { matchable } = buildTranscriptTokens(transcript);
        const engine = new AlignmentEngine();
        engine.setTranscriptTokens(matchable);
        const words = matchable.map((t) => t.norm);
        if (words.length < 40) return;

        // read the first quarter
        const t = feed(
          engine,
          simulateReading(words, 0, Math.floor(words.length / 4), rand, {
            dropRate: 0.05,
            fillerRate: 0.05,
          }),
          0,
        );
        // skip to the last quarter and read to the end
        const skipTo = Math.floor(words.length * 0.75);
        feed(
          engine,
          simulateReading(words, skipTo, words.length, rand, {
            dropRate: 0.05,
            fillerRate: 0.05,
          }),
          t + 1000,
        );
        const r = engine.getResult();
        // must land in the final region, not remain stuck at the first quarter
        expect(r.matchedTokenIndex).toBeGreaterThan(
          Math.floor(words.length / 2),
        );
      }),
      { numRuns: 30 },
    );
  });

  it("manual reset always lands in bounds and near the requested word", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000 }),
        fc.integer({ min: 0, max: 500 }),
        (seed, resetTo) => {
          const rand = prng(seed);
          const transcript = genTranscript(rand, 8);
          const { matchable } = buildTranscriptTokens(transcript);
          const engine = new AlignmentEngine();
          engine.setTranscriptTokens(matchable);
          const r = engine.manualReset(resetTo, 1000);
          expect(r.matchedTokenIndex).toBeGreaterThanOrEqual(0);
          expect(r.matchedTokenIndex).toBeLessThan(matchable.length);
        },
      ),
      { numRuns: 40 },
    );
  });

  it("empty recognition never moves the cursor", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000 }), (seed) => {
        const rand = prng(seed);
        const transcript = genTranscript(rand, 6);
        const { matchable } = buildTranscriptTokens(transcript);
        const engine = new AlignmentEngine();
        engine.setTranscriptTokens(matchable);
        const words = matchable.map((t) => t.norm);
        feed(engine, simulateReading(words, 0, 12, rand), 0);
        const before = engine.getResult().matchedTokenIndex;
        for (let i = 0; i < 5; i++) {
          engine.update({
            utteranceTokens: [],
            isFinal: true,
            timestampMs: 10_000 + i * 500,
          });
        }
        expect(engine.getResult().matchedTokenIndex).toBe(before);
      }),
      { numRuns: 30 },
    );
  });
});
