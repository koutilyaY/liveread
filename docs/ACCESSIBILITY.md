# LiveRead — Accessibility

Target: **WCAG 2.2 AA** where practical. Reading is the core use case, so the
reading experience must work without a microphone, without a mouse, and without
motion.

## Implemented

| Requirement                   | Implementation                                                                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Keyboard navigation           | all controls are native `button`/`input`/`select`; words are focusable and respond to Enter/Space                                              |
| Focus visibility              | global `:focus-visible` outline (2px, offset) — never removed                                                                                  |
| Screen-reader labels          | `aria-label` on the transcript region, mic meter (`role="meter"`), reading progress (`role="progressbar"`), all sliders and toggles            |
| Semantic headings             | one `h1` per page, `h2` for sections                                                                                                           |
| Contrast                      | fixed two real axe findings (see below); optional high-contrast mode                                                                           |
| Reduced motion                | `prefers-reduced-motion` disables smooth scroll and animations (CSS + JS check before `scrollIntoView`)                                        |
| Live-region announcements     | single polite `aria-live` region carrying only _state changes_ (caught up, degraded) — never interim tokens, which would flood a screen reader |
| Large text                    | font size 0.8–2.0rem, line spacing 1.4–2.6                                                                                                     |
| No color-only status          | every status pill pairs color with text ("● Live", "Paused", "corrected")                                                                      |
| Transcript without microphone | full transcript readable; tap/Enter any word to move the cursor                                                                                |
| Manual navigation fallback    | complete, not degraded — the same cursor, highlighting, and auto-scroll                                                                        |
| Autoplay                      | audio is `controls`-only; nothing plays without a gesture                                                                                      |

## Automated testing

`e2e/accessibility.spec.ts` (axe-core via `@axe-core/playwright`), run by
`make test-accessibility`. Asserts **zero serious/critical violations** on: `/`,
`/signin`, `/signup`, `/privacy`, `/accessibility`, and the **live viewer page**
with real transcript content.

**Result (2026-07-15): 2/2 passed.**

Two real violations were found and fixed during the build (not suppressed):

1. `text-zinc-400` footer/report text on white — insufficient contrast → `text-zinc-600 dark:text-zinc-400`.
2. Interim transcript rendered with `opacity-50`, dropping it below 4.5:1 → explicit `text-zinc-600 dark:text-zinc-400`, which keeps the "reduced contrast" design intent while remaining legible.

## Documented manual checks (performed)

| Check                                                                 | Result                                                    |
| --------------------------------------------------------------------- | --------------------------------------------------------- |
| Keyboard-only creator flow: signup → new session → preflight → start  | pass                                                      |
| Keyboard-only viewer: open link → Read Aloud → move cursor with Enter | pass                                                      |
| Reduced-motion: auto-scroll jumps instead of animating                | pass (`behavior: "auto"` branch)                          |
| Reading with the microphone never enabled                             | pass — manual cursor is fully functional                  |
| Zoom to 200%                                                          | layout reflows; no horizontal scrolling of the transcript |
| Status conveyed without color                                         | pass — all pills carry text                               |

## Known gaps (honest)

1. **No screen-reader testing with real AT** (NVDA/JAWS/VoiceOver). The live-region design is reasoned and labeled but unverified with actual assistive technology.
2. **Touch-target sizing is not systematically audited.** Primary buttons meet 44×44px; individual transcript words are text-sized by design (tapping a word is a convenience — the sentence is the intended target).
3. **No formal WCAG 2.2 AA conformance audit** by a specialist. Automated tooling catches roughly a third of real issues.
4. axe only checks rendered states; some transient states (mid-reconnect) are not covered.

An accessibility statement is published at `/accessibility` in the app.
