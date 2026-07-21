import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { openViewer, startLiveSession } from "./helpers";

/**
 * Automated accessibility checks (axe-core) on the key surfaces.
 * Documented manual checks live in docs/ACCESSIBILITY.md.
 */

async function expectNoSeriousViolations(
  results: Awaited<ReturnType<AxeBuilder["analyze"]>>,
  label: string,
) {
  const serious = results.violations.filter((v) =>
    ["serious", "critical"].includes(v.impact ?? ""),
  );
  expect(
    serious.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => n.html.slice(0, 120)),
    })),
    label,
  ).toEqual([]);
}

test("landing, auth, and legal pages have no serious axe violations", async ({
  page,
}) => {
  for (const path of [
    "/",
    "/signin",
    "/signup",
    "/privacy",
    "/accessibility",
  ]) {
    await page.goto(path);
    const results = await new AxeBuilder({ page }).analyze();
    await expectNoSeriousViolations(results, path);
  }
});

test("live viewer page has no serious axe violations", async ({
  page,
  browser,
}) => {
  const { viewerUrl } = await startLiveSession(page, "A11y Session");
  const viewer = await openViewer(browser, viewerUrl);
  await expect(viewer.getByTestId("final-transcript")).toContainText(
    "Welcome everyone",
    { timeout: 30_000 },
  );
  const results = await new AxeBuilder({ page: viewer }).analyze();
  await expectNoSeriousViolations(results, "viewer page");
  await viewer.context().close();
});

/**
 * Reading-surface checks that axe does NOT perform.
 *
 * axe evaluates text contrast against the element's own background, so it was
 * blind to the reading highlight being a *graphical object* under WCAG 1.4.11
 * Non-text Contrast. The sentence band shipped at 1.66:1 against the page in
 * dark mode and no automated check objected. These assertions close that gap.
 *
 * Colours are resolved through a canvas because Tailwind 4 emits `oklch()`,
 * which a naive numeric scrape of the computed style misreads as rgb.
 */
test("reading highlight meets non-text contrast and the measure stays readable", async ({
  page,
  browser,
}) => {
  const { viewerUrl } = await startLiveSession(page, "Contrast Check");
  const viewer = await openViewer(browser, viewerUrl);
  await viewer.waitForSelector("[data-word-index]", { timeout: 30_000 });
  await viewer.setViewportSize({ width: 1440, height: 900 });

  const report = await viewer.evaluate(() => {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 1;
    const ctx = cv.getContext("2d", { willReadFrequently: true })!;
    const toRGB = (css: string): [number, number, number] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000";
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0]!, d[1]!, d[2]!];
    };
    const chan = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    const lum = ([r, g, b]: [number, number, number]) =>
      0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
    const ratio = (
      a: [number, number, number],
      b: [number, number, number],
    ) => {
      const [x, y] = [lum(a), lum(b)];
      const [hi, lo] = x > y ? [x, y] : [y, x];
      return (hi + 0.05) / (lo + 0.05);
    };

    const card = document.querySelector<HTMLElement>(
      '[data-testid="transcript-view"]',
    )!;
    // nearest ancestor with a real background
    let bgEl: HTMLElement | null = card;
    let pageBg: [number, number, number] = [255, 255, 255];
    while (bgEl) {
      const c = getComputedStyle(bgEl).backgroundColor;
      if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) {
        pageBg = toRGB(c);
        break;
      }
      bgEl = bgEl.parentElement;
    }

    const probeClass = (cls: string) => {
      const el = document.createElement("span");
      el.className = cls;
      el.textContent = "x";
      card.appendChild(el);
      const cs = getComputedStyle(el);
      const out = {
        bg: toRGB(cs.backgroundColor),
        fg: toRGB(cs.color),
      };
      el.remove();
      return out;
    };
    const word = probeClass("word-active");

    // characters per line on the reading column
    const sample = document.querySelector<HTMLElement>("[data-word-index]")!;
    const cs = getComputedStyle(sample);
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
    probe.style.font = cs.font;
    probe.textContent = "0".repeat(100);
    document.body.appendChild(probe);
    const chW = probe.getBoundingClientRect().width / 100;
    probe.remove();
    const inner = card.clientWidth - 64; // sm:px-8

    return {
      wordVsPage: ratio(word.bg, pageBg),
      textOnWord: ratio(word.fg, word.bg),
      charsPerLine: Math.round(inner / chW),
    };
  });

  // WCAG 1.4.11: the reading cursor is required to understand the content
  expect(
    report.wordVsPage,
    "active-word highlight vs page background",
  ).toBeGreaterThanOrEqual(3);
  // WCAG 1.4.3: the word's own text sits on the highlight, not the page
  expect(
    report.textOnWord,
    "text on the active-word highlight",
  ).toBeGreaterThanOrEqual(4.5);
  // Butterick / Tailwind prose: keep the measure in the comfortable band
  expect(
    report.charsPerLine,
    "characters per line on desktop",
  ).toBeLessThanOrEqual(75);
  expect(
    report.charsPerLine,
    "characters per line on desktop",
  ).toBeGreaterThanOrEqual(45);

  await viewer.context().close();
});
