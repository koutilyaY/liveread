/**
 * Language-aware tokenization and normalization for transcript matching.
 *
 * Normalization is applied ONLY to matching keys. The canonical displayed
 * transcript text is never modified.
 */

export type Script = "latin" | "devanagari" | "arabic" | "cjk";

export interface LanguageProfile {
  code: string;
  script: Script;
  tokenization: "whitespace" | "char";
  fillerWords: ReadonlySet<string>;
  stripDiacritics: boolean;
  expandContractions: boolean;
}

const EN_FILLERS = new Set([
  "uh",
  "um",
  "er",
  "ah",
  "hmm",
  "mmm",
  "uhh",
  "umm",
  "erm",
]);
const ES_FILLERS = new Set(["eh", "em", "este", "pues", "mmm"]);

const PROFILES: Record<string, Omit<LanguageProfile, "code">> = {
  en: {
    script: "latin",
    tokenization: "whitespace",
    fillerWords: EN_FILLERS,
    stripDiacritics: true,
    expandContractions: true,
  },
  es: {
    script: "latin",
    tokenization: "whitespace",
    fillerWords: ES_FILLERS,
    stripDiacritics: true,
    expandContractions: false,
  },
  hi: {
    script: "devanagari",
    tokenization: "whitespace",
    fillerWords: new Set<string>(),
    stripDiacritics: false,
    expandContractions: false,
  },
  ar: {
    script: "arabic",
    tokenization: "whitespace",
    fillerWords: new Set<string>(),
    stripDiacritics: true,
    expandContractions: false,
  },
  zh: {
    script: "cjk",
    tokenization: "char",
    fillerWords: new Set<string>(),
    stripDiacritics: false,
    expandContractions: false,
  },
  ja: {
    script: "cjk",
    tokenization: "char",
    fillerWords: new Set<string>(),
    stripDiacritics: false,
    expandContractions: false,
  },
};

export function getLanguageProfile(languageCode: string): LanguageProfile {
  const base = languageCode.toLowerCase().split(/[-_]/)[0] ?? "en";
  const profile = PROFILES[base] ?? PROFILES["en"]!;
  return { code: base, ...profile };
}

const EN_CONTRACTIONS: Record<string, string> = {
  "can't": "cannot",
  "won't": "will not",
  "n't": " not",
  "'re": " are",
  "'ve": " have",
  "'ll": " will",
  "'d": " would",
  "'m": " am",
  "it's": "it is",
  "that's": "that is",
  "what's": "what is",
  "let's": "let us",
};

const EN_NUMBER_WORDS: Record<string, string> = {
  zero: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
  eleven: "11",
  twelve: "12",
  thirteen: "13",
  fourteen: "14",
  fifteen: "15",
  sixteen: "16",
  seventeen: "17",
  eighteen: "18",
  nineteen: "19",
  twenty: "20",
  thirty: "30",
  forty: "40",
  fifty: "50",
  sixty: "60",
  seventy: "70",
  eighty: "80",
  ninety: "90",
  hundred: "100",
  thousand: "1000",
};

// Arabic tashkeel + tatweel
const ARABIC_DIACRITICS = /[ً-ٰٟـ]/g;

function normalizeArabic(word: string): string {
  return word
    .replace(ARABIC_DIACRITICS, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه");
}

/** Strip combining marks after NFD decomposition (Latin diacritics). */
function stripLatinDiacritics(word: string): string {
  return word.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

const PUNCT = /[!-/:-@[-`{-~¡¿«»“”‘’…—–،؛؟。、！？；：「」『』（）·॥]/g;

/**
 * Normalize a single word into its matching key. Returns "" when the word
 * carries no matching content (pure punctuation, filler word).
 */
export function normalizeWord(word: string, profile: LanguageProfile): string {
  let w = word.normalize("NFKC").toLowerCase();
  w = w.replace(/[’‘`´]/g, "'");
  if (profile.expandContractions && profile.code === "en") {
    for (const [pattern, expansion] of Object.entries(EN_CONTRACTIONS)) {
      if (w.endsWith(pattern) || w === pattern) {
        w = w.replace(pattern, expansion);
        break;
      }
    }
  }
  w = w.replace(PUNCT, "");
  w = w.replace(/\s+/g, " ").trim();
  if (profile.script === "arabic") w = normalizeArabic(w);
  else if (profile.stripDiacritics && profile.script === "latin") {
    w = stripLatinDiacritics(w);
  }
  // number canonicalization: strip digit-group separators; map number words
  if (/^\d[\d,.]*$/.test(w)) w = w.replace(/[,]/g, "");
  if (profile.code === "en" && EN_NUMBER_WORDS[w]) w = EN_NUMBER_WORDS[w]!;
  if (profile.fillerWords.has(w)) return "";
  return w;
}

export interface DisplayToken {
  /** Original text as displayed (never normalized). */
  text: string;
  /** Normalized matching key; "" means non-matchable (filler/punctuation). */
  norm: string;
  charStart: number;
  charEnd: number;
  sentenceIndex: number;
  wordIndex: number;
}

const SENTENCE_ENDERS = new Set([
  ".",
  "!",
  "?",
  "…",
  "。",
  "！",
  "？",
  "؟",
  "।",
  "॥",
  ";",
  "；",
]);

/**
 * Tokenize text into display tokens with sentence indices and char offsets.
 * Whitespace scripts split on whitespace; CJK splits per character while
 * keeping embedded Latin/digit runs together.
 */
export function tokenize(
  text: string,
  profile: LanguageProfile,
  opts?: { sentenceOffset?: number; wordOffset?: number },
): DisplayToken[] {
  const tokens: DisplayToken[] = [];
  let sentenceIndex = opts?.sentenceOffset ?? 0;
  let wordIndex = opts?.wordOffset ?? 0;

  const pushToken = (raw: string, start: number, end: number) => {
    if (!raw) return;
    tokens.push({
      text: raw,
      norm: normalizeWord(raw, profile),
      charStart: start,
      charEnd: end,
      sentenceIndex,
      wordIndex: wordIndex++,
    });
    const last = raw[raw.length - 1];
    if (last !== undefined && SENTENCE_ENDERS.has(last)) sentenceIndex++;
  };

  if (profile.tokenization === "char") {
    let i = 0;
    while (i < text.length) {
      const ch = text[i]!;
      if (/\s/.test(ch)) {
        i++;
        continue;
      }
      if (/[A-Za-z0-9]/.test(ch)) {
        let j = i;
        while (j < text.length && /[A-Za-z0-9]/.test(text[j]!)) j++;
        pushToken(text.slice(i, j), i, j);
        i = j;
        continue;
      }
      pushToken(ch, i, i + 1);
      i++;
    }
  } else {
    const re = /\S+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      pushToken(m[0], m.index, m.index + m[0].length);
    }
  }
  return tokens;
}

/** Tokens that participate in matching (non-empty normalized key). */
export function matchableTokens(tokens: DisplayToken[]): DisplayToken[] {
  return tokens.filter((t) => t.norm !== "");
}

/** Normalize a free-text recognition result into matching keys. */
export function normalizeUtterance(
  text: string,
  profile: LanguageProfile,
): string[] {
  return tokenize(text, profile)
    .map((t) => t.norm)
    .filter((n) => n !== "");
}
