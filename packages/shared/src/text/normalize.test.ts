import { describe, expect, it } from "vitest";
import {
  getLanguageProfile,
  matchableTokens,
  normalizeUtterance,
  normalizeWord,
  tokenize,
} from "./normalize.js";

describe("normalizeWord (en)", () => {
  const en = getLanguageProfile("en-US");

  it("lowercases and strips punctuation", () => {
    expect(normalizeWord("Hello,", en)).toBe("hello");
    expect(normalizeWord("world!", en)).toBe("world");
    expect(normalizeWord("“quoted”", en)).toBe("quoted");
  });

  it("normalizes apostrophes and expands contractions", () => {
    expect(normalizeWord("don’t", en)).toBe("do not");
    expect(normalizeWord("can't", en)).toBe("cannot");
    expect(normalizeWord("it's", en)).toBe("it is");
  });

  it("normalizes numbers", () => {
    expect(normalizeWord("1,000", en)).toBe("1000");
    expect(normalizeWord("twenty", en)).toBe("20");
    expect(normalizeWord("Seven", en)).toBe("7");
  });

  it("drops filler words", () => {
    expect(normalizeWord("um", en)).toBe("");
    expect(normalizeWord("Uh,", en)).toBe("");
  });

  it("strips diacritics for latin script", () => {
    expect(normalizeWord("café", en)).toBe("cafe");
    expect(normalizeWord("naïve", en)).toBe("naive");
  });
});

describe("tokenize", () => {
  it("assigns sentence indices across sentence boundaries", () => {
    const en = getLanguageProfile("en");
    const tokens = tokenize("First sentence. Second one! Third?", en);
    const sentenceOf = (word: string) =>
      tokens.find((t) => t.text.startsWith(word))!.sentenceIndex;
    expect(sentenceOf("First")).toBe(0);
    expect(sentenceOf("Second")).toBe(1);
    expect(sentenceOf("Third")).toBe(2);
  });

  it("keeps char offsets into the original text", () => {
    const en = getLanguageProfile("en");
    const text = "Hello brave world";
    const tokens = tokenize(text, en);
    for (const t of tokens) {
      expect(text.slice(t.charStart, t.charEnd)).toBe(t.text);
    }
  });

  it("tokenizes Mandarin per character with Latin runs intact", () => {
    const zh = getLanguageProfile("zh-CN");
    const tokens = tokenize("我喜欢LiveKit平台。", zh);
    expect(tokens.map((t) => t.text)).toEqual([
      "我",
      "喜",
      "欢",
      "LiveKit",
      "平",
      "台",
      "。",
    ]);
    // sentence boundary after 。
    expect(tokens[tokens.length - 1]!.sentenceIndex).toBe(0);
  });

  it("handles Hindi with danda sentence boundaries", () => {
    const hi = getLanguageProfile("hi-IN");
    const tokens = tokenize("नमस्ते दुनिया। यह परीक्षण है।", hi);
    expect(tokens[0]!.sentenceIndex).toBe(0);
    expect(tokens[tokens.length - 1]!.sentenceIndex).toBe(1);
  });

  it("normalizes Arabic diacritics and alef variants", () => {
    const ar = getLanguageProfile("ar");
    expect(normalizeWord("أَهْلاً", ar)).toBe(normalizeWord("اهلا", ar));
  });

  it("handles mixed-language text without crashing", () => {
    const en = getLanguageProfile("en");
    const tokens = tokenize("The word नमस्ते means hello in हिंदी.", en);
    expect(tokens.length).toBeGreaterThan(5);
    expect(matchableTokens(tokens).every((t) => t.norm !== "")).toBe(true);
  });
});

describe("normalizeUtterance", () => {
  it("produces matching keys and drops fillers", () => {
    const en = getLanguageProfile("en");
    expect(normalizeUtterance("Um, hello brave NEW world!", en)).toEqual([
      "hello",
      "brave",
      "new",
      "world",
    ]);
  });
});
