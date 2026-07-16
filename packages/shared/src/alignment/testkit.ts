import {
  getLanguageProfile,
  matchableTokens,
  tokenize,
  normalizeUtterance,
  type DisplayToken,
} from "../text/normalize.js";
import type { TranscriptToken } from "./engine.js";

/**
 * Test/evaluation helpers for the alignment engine. Deterministic: any
 * randomness comes from a caller-provided PRNG.
 */

export function buildTranscriptTokens(
  text: string,
  languageCode = "en",
  segmentId = "00000000-0000-0000-0000-000000000001",
): { display: DisplayToken[]; matchable: TranscriptToken[] } {
  const profile = getLanguageProfile(languageCode);
  const display = tokenize(text, profile);
  const matchable = matchableTokens(display).map((t) => ({
    norm: t.norm,
    displayWordIndex: t.wordIndex,
    sentenceIndex: t.sentenceIndex,
    segmentId,
  }));
  return { display, matchable };
}

export function utteranceTokens(text: string, languageCode = "en"): string[] {
  return normalizeUtterance(text, getLanguageProfile(languageCode));
}

/** Deterministic PRNG (mulberry32) for property/evaluation tests. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface NoiseOptions {
  dropRate?: number;
  fillerRate?: number;
  substituteRate?: number;
  repeatRate?: number;
}

const FILLERS = ["um", "uh", "er"];
const SUBSTITUTES = ["banana", "kumquat", "zephyr", "quixotic"];

/**
 * Simulate a reader speaking the transcript words [from, to) with noise.
 * Returns utterances: bursts of tokens as a recognizer would emit them.
 */
export function simulateReading(
  words: string[],
  from: number,
  to: number,
  rand: () => number,
  noise: NoiseOptions = {},
  burstSize = 4,
): string[][] {
  const {
    dropRate = 0,
    fillerRate = 0,
    substituteRate = 0,
    repeatRate = 0,
  } = noise;
  const spoken: string[] = [];
  for (let i = from; i < to; i++) {
    const w = words[i]!;
    if (rand() < dropRate) continue;
    if (rand() < fillerRate)
      spoken.push(FILLERS[Math.floor(rand() * FILLERS.length)]!);
    if (rand() < substituteRate) {
      spoken.push(SUBSTITUTES[Math.floor(rand() * SUBSTITUTES.length)]!);
    } else {
      spoken.push(w);
    }
    if (rand() < repeatRate) spoken.push(w);
  }
  const utterances: string[][] = [];
  for (let i = 0; i < spoken.length; i += burstSize) {
    utterances.push(spoken.slice(i, i + burstSize));
  }
  return utterances;
}
