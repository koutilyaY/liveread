import { describe, expect, it } from "vitest";
import { AlignmentEngine } from "./engine.js";
import { buildTranscriptTokens, utteranceTokens } from "./testkit.js";

/**
 * Hostile input tests for the alignment engine.
 *
 * The engine consumes browser speech-recognition output, which is untrusted
 * and messy, and its cursor drives what the reader sees. A crash, an
 * out-of-bounds index, or a NaN confidence would break the reading UI. These
 * assert the stated contract holds under input the happy-path and
 * property-based tests do not generate.
 */

const TEXT =
  "The quick brown fox jumps over the lazy dog. ".repeat(3) +
  "A totally different sentence appears here now. " +
  "The quick brown fox jumps over the lazy dog.";

function makeEngine() {
  const { matchable } = buildTranscriptTokens(TEXT);
  const engine = new AlignmentEngine();
  engine.setTranscriptTokens(matchable);
  return { engine, tokens: matchable };
}

describe("alignment engine: hostile input", () => {
  it("is deterministic — identical input sequences produce identical output", () => {
    const seq = [
      ["the", "quick", "brown"],
      ["fox", "jumps", "over"],
      ["the", "lazy", "dog"],
    ];
    const run = () => {
      const { engine } = makeEngine();
      let t = 0;
      return seq.map((u) => {
        const r = engine.update({
          utteranceTokens: u,
          isFinal: true,
          timestampMs: (t += 500),
        });
        return `${r.matchedWordIndex}:${r.state}:${r.confidence.toFixed(6)}`;
      });
    };
    // no Date.now(), no randomness: same inputs must give the same cursor
    expect(run()).toEqual(run());
  });

  it("never crashes, goes out of bounds, or emits invalid confidence", () => {
    const { engine, tokens } = makeEngine();
    const nasty: string[][] = [
      [],
      [""],
      ["   "],
      ["\u{1F600}", "\u{1F389}"], // emoji
      ["<script>alert(1)</script>"], // markup
      Array(5000).fill("x"), // absurdly long utterance
      ["THE", "QUICK"], // wrong case
      ["...", "!!!"], // punctuation only
      ["نص", "عربي"], // wrong script entirely
      ["中文", "字符"],
    ];
    let t = 0;
    for (const u of nasty) {
      const r = engine.update({
        utteranceTokens: u,
        isFinal: true,
        timestampMs: (t += 100),
      });
      expect(r.matchedWordIndex).toBeGreaterThanOrEqual(-1);
      expect(r.matchedWordIndex).toBeLessThan(tokens.length);
      expect(Number.isNaN(r.confidence)).toBe(false);
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("clamps manual reset to a valid position for any index", () => {
    const { engine, tokens } = makeEngine();
    for (const idx of [
      -999,
      -1,
      0,
      tokens.length - 1,
      tokens.length,
      999_999,
    ]) {
      const r = engine.manualReset(idx, 1000);
      expect(Number.isNaN(r.matchedWordIndex)).toBe(false);
      expect(r.matchedWordIndex).toBeGreaterThanOrEqual(-1);
      expect(r.matchedWordIndex).toBeLessThan(tokens.length);
    }
  });

  it("keeps the cursor valid when the transcript shrinks beneath it", () => {
    const { engine, tokens } = makeEngine();
    engine.update({
      utteranceTokens: utteranceTokens("the quick brown fox jumps"),
      isFinal: true,
      timestampMs: 1000,
    });
    // a creator deletion or correction can shorten the canonical transcript
    engine.setTranscriptTokens(tokens.slice(0, 3));
    const r = engine.update({
      utteranceTokens: ["jumps"],
      isFinal: true,
      timestampMs: 2000,
    });
    expect(r.matchedWordIndex).toBeGreaterThanOrEqual(-1);
    expect(r.matchedWordIndex).toBeLessThan(3);
  });

  it("empty recognition never moves an established cursor", () => {
    const { engine } = makeEngine();
    const first = engine.update({
      utteranceTokens: utteranceTokens("the quick brown fox"),
      isFinal: true,
      timestampMs: 1000,
    });
    const before = first.matchedWordIndex;
    const after = engine.update({
      utteranceTokens: [],
      isFinal: true,
      timestampMs: 1500,
    });
    expect(after.matchedWordIndex).toBe(before);
  });
});
