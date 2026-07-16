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
