# LiveRead — Internationalization

## Position

The **tokenization and alignment layer is genuinely language-aware and tested**.
The **UI is English-only today**, but no architectural decision blocks
translation. This document is explicit about which is which.

## Implemented and tested

`packages/shared/src/text/normalize.ts` — per-language profiles:

| Language       | Script     | Tokenization                                    | Normalization specifics                                   | Tested |
| -------------- | ---------- | ----------------------------------------------- | --------------------------------------------------------- | ------ |
| English        | Latin      | whitespace                                      | contractions, number words, diacritics, fillers           | ✅     |
| Spanish        | Latin      | whitespace                                      | diacritics, Spanish fillers (`eh`, `este`, `pues`)        | ✅     |
| Hindi          | Devanagari | whitespace                                      | danda `।॥` sentence boundaries; no case/diacritic folding | ✅     |
| Arabic         | Arabic     | whitespace                                      | tashkeel/tatweel removal, alef/ya/ta-marbuta folding, `؟` | ✅     |
| Mandarin       | CJK        | **per character**, Latin/digit runs kept intact | `。！？` boundaries                                       | ✅     |
| Mixed-language | —          | host-language profile                           | must not crash or drop tokens                             | ✅     |

Automated tests exist for all six (`normalize.test.ts`,
`evaluation.test.ts`) — exactly the list the specification requires.

Other properties:

- **Unicode-safe storage**: Postgres UTF-8; NFKC normalization for matching keys only — the canonical displayed transcript is never modified.
- **Scripts without whitespace**: handled by the `char` tokenization strategy, with sentence indices from CJK punctuation.
- **Language selection**: per session at creation (6 languages offered), passed to the STT provider and to the alignment profile.
- **Configurable providers by language**: `supportedLanguages()` per provider; preflight surfaces `languageSupported` before the creator starts.
- **Locale-aware dates/numbers**: `toLocaleString()` (browser locale). `users.locale` and `users.timezone` columns exist.
- **Accessibility labels**: written as plain strings ready for extraction — no concatenated sentence fragments that would break translation.

## Not implemented (honest)

1. **No UI localization framework wired up** (no next-intl/i18next). Copy is inline English. The strings are extraction-ready, but extraction has not been done. **This is the largest i18n gap.**
2. **No RTL layout**. `dir="rtl"` is not applied and the layout has not been mirrored, though Arabic _text normalization and alignment_ are implemented and tested. Arabic transcripts align correctly; the surrounding chrome would still read LTR.
3. **No browser timezone auto-detection** on signup (the column exists, defaults to UTC).
4. Thai/Lao/Khmer (no whitespace, no per-char equivalence) would need a dictionary segmenter; the `tokenization` strategy is the extension point.
5. Japanese uses the CJK char path; proper morphological analysis (MeCab-class) is not implemented.

## What we do not claim

**Recognition quality is not equal across languages.** Alignment is tested
across the six above; _recognition_ accuracy depends entirely on the configured
provider, the speaker, and the audio. The fake provider's English script proves
the pipeline, not multilingual accuracy.
