import { describe, expect, it } from "vitest";
import { AlignmentEngine, type AlignmentResult } from "./engine.js";
import { buildTranscriptTokens, utteranceTokens } from "./testkit.js";

const TRANSCRIPT =
  "Today I want to explain how rivers shape the land around them. " +
  "Water always moves downhill under the pull of gravity. " +
  "As it moves it carries small stones and grains of sand. " +
  "Over many years this slow movement carves deep valleys. " +
  "The fastest water sits in the middle of the channel. " +
  "Slower water near the banks drops its heavy load first. " +
  "That is why river bends grow wider every single season. " +
  "People have watched this process for thousands of years.";

function makeEngine() {
  const { matchable } = buildTranscriptTokens(TRANSCRIPT);
  const engine = new AlignmentEngine();
  engine.setTranscriptTokens(matchable);
  return { engine, tokens: matchable };
}

/** Feed the engine one utterance (interim growth + final), advancing time. */
function speak(
  engine: AlignmentEngine,
  text: string,
  t0: number,
  stepMs = 250,
): { result: AlignmentResult; tEnd: number } {
  const toks = utteranceTokens(text);
  let t = t0;
  let result = engine.getResult();
  for (let i = 1; i <= toks.length; i++) {
    result = engine.update({
      utteranceTokens: toks.slice(0, i),
      isFinal: i === toks.length,
      timestampMs: t,
    });
    t += stepMs;
  }
  return { result, tEnd: t };
}

describe("AlignmentEngine — basic tracking", () => {
  it("waits when there is no transcript", () => {
    const engine = new AlignmentEngine();
    const r = engine.update({
      utteranceTokens: ["hello", "world"],
      isFinal: false,
      timestampMs: 0,
    });
    expect(r.state).toBe("waiting");
    expect(r.matchedWordIndex).toBe(-1);
    expect(r.reasonCodes).toContain("no_transcript");
  });

  it("tracks an exact reading forward monotonically", () => {
    const { engine } = makeEngine();
    let t = 0;
    let last = -1;
    for (const sentence of TRANSCRIPT.split(". ").slice(0, 4)) {
      const { result, tEnd } = speak(engine, sentence, t);
      t = tEnd;
      expect(result.state).toBe("tracking");
      expect(result.matchedTokenIndex).toBeGreaterThan(last);
      last = result.matchedTokenIndex;
    }
    expect(engine.getResult().confidence).toBeGreaterThan(0.5);
  });

  it("tolerates omitted small words and added fillers", () => {
    const { engine } = makeEngine();
    // reader drops "I want to" and adds fillers
    const { result: r1 } = speak(
      engine,
      "Today um explain how rivers shape uh the land around them",
      0,
    );
    expect(r1.state).toBe("tracking");
    const { result: r2 } = speak(
      engine,
      "water moves downhill under pull of gravity",
      4000,
    );
    expect(r2.state).toBe("tracking");
    expect(r2.matchedTokenIndex).toBeGreaterThan(r1.matchedTokenIndex);
  });

  it("starts mid-transcript via global acquisition", () => {
    const { engine } = makeEngine();
    const { result } = speak(
      engine,
      "the fastest water sits in the middle of the channel",
      0,
    );
    expect(result.state).toBe("tracking");
    expect(result.matchedSentenceIndex).toBe(4);
  });
});

describe("AlignmentEngine — stability & hysteresis", () => {
  it("does not jump on a single weak partial match", () => {
    const { engine } = makeEngine();
    speak(engine, "Today I want to explain how rivers shape the land", 0);
    const before = engine.getResult().matchedTokenIndex;
    // one ambiguous common word ("water" appears in several sentences)
    const r = engine.update({
      utteranceTokens: ["water"],
      isFinal: false,
      timestampMs: 5000,
    });
    expect(Math.abs(r.matchedTokenIndex - before)).toBeLessThanOrEqual(14);
  });

  it("repeated phrases near the cursor do not cause a jump to a distant duplicate", () => {
    const { engine } = makeEngine();
    // "water" appears in sentences 2, 5 and 6 — read sentence 2, repeat it
    speak(engine, "Water always moves downhill under the pull of gravity", 0);
    const first = engine.getResult().matchedTokenIndex;
    const { result } = speak(
      engine,
      "Water always moves downhill under the pull of gravity",
      5000,
    );
    // re-reading the same sentence must keep the cursor in that neighborhood
    expect(Math.abs(result.matchedTokenIndex - first)).toBeLessThanOrEqual(14);
  });

  it("recovers a large forward skip with confirmation", () => {
    const { engine } = makeEngine();
    speak(
      engine,
      "Today I want to explain how rivers shape the land around them",
      0,
    );
    // skip ahead 5 sentences
    const { result: r1, tEnd } = speak(
      engine,
      "That is why river bends grow wider every single season",
      6000,
    );
    const { result: r2 } = speak(
      engine,
      "People have watched this process for thousands of years",
      tEnd + 500,
    );
    const landed =
      r1.matchedSentenceIndex === 6 || r2.matchedSentenceIndex === 7;
    expect(landed).toBe(true);
  });

  it("recovers backward reading with stronger evidence", () => {
    const { engine } = makeEngine();
    speak(engine, "Slower water near the banks drops its heavy load first", 0);
    expect(engine.getResult().matchedSentenceIndex).toBe(5);
    const { result: r1, tEnd } = speak(
      engine,
      "Water always moves downhill under the pull of gravity",
      5000,
    );
    const { result: r2 } = speak(
      engine,
      "As it moves it carries small stones and grains of sand",
      tEnd + 500,
    );
    const recovered =
      r1.matchedSentenceIndex === 1 || r2.matchedSentenceIndex === 2;
    expect(recovered).toBe(true);
  });

  it("becomes uncertain then lost when speech stops matching", () => {
    const { engine } = makeEngine();
    speak(engine, "Today I want to explain how rivers shape the land", 0);
    expect(engine.getResult().state).toBe("tracking");
    // gibberish for a long time
    let t = 10_000;
    for (let i = 0; i < 10; i++) {
      engine.update({
        utteranceTokens: ["flibber", "gibber"],
        isFinal: true,
        timestampMs: t,
      });
      t += 2000;
    }
    expect(["uncertain", "lost"]).toContain(engine.getResult().state);
  });
});

describe("AlignmentEngine — caught up and continuation", () => {
  it("detects catch-up at the end of finalized text and resumes on new text", () => {
    const shortText = "The sun rises in the east. The sky turns gold.";
    const { matchable } = buildTranscriptTokens(shortText);
    const engine = new AlignmentEngine();
    engine.setTranscriptTokens(matchable);

    speak(engine, "The sun rises in the east", 0);
    const { result } = speak(engine, "the sky turns gold", 3000);
    expect(result.state).toBe("caught_up");

    // creator adds a new sentence
    const grown = buildTranscriptTokens(
      shortText + " Birds begin to sing in the trees.",
    );
    engine.setTranscriptTokens(grown.matchable);
    expect(engine.getState()).toBe("tracking");
    const { result: r2 } = speak(
      engine,
      "birds begin to sing in the trees",
      6000,
    );
    expect(r2.state).toBe("caught_up");
    expect(r2.matchedSentenceIndex).toBe(2);
  });
});

describe("AlignmentEngine — manual reset", () => {
  it("restarts local alignment at the chosen position without snapping back", () => {
    const { engine, tokens } = makeEngine();
    speak(
      engine,
      "Today I want to explain how rivers shape the land around them",
      0,
    );
    // user taps sentence 4 ("The fastest water...")
    const target = tokens.find((t) => t.sentenceIndex === 4)!;
    const r = engine.manualReset(target.displayWordIndex, 5000);
    expect(r.matchedSentenceIndex).toBe(4);
    expect(r.reasonCodes).toContain("manual_reset");
    const { result } = speak(
      engine,
      "the fastest water sits in the middle of the channel",
      5500,
    );
    expect(result.matchedSentenceIndex).toBe(4);
    expect(result.state).toBe("tracking");
  });
});

describe("AlignmentEngine — determinism", () => {
  it("identical input sequences produce identical results", () => {
    const run = () => {
      const { engine } = makeEngine();
      const outputs: AlignmentResult[] = [];
      let t = 0;
      for (const s of TRANSCRIPT.split(". ")) {
        const { result, tEnd } = speak(engine, s, t);
        outputs.push(result);
        t = tEnd;
      }
      return outputs;
    };
    expect(run()).toEqual(run());
  });
});
