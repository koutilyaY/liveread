import { expect, test } from "@playwright/test";
import { openViewer, startLiveSession, viewerSay } from "./helpers";

/**
 * The core product flow (spec: E2E "Creator and viewer live session"):
 * creator goes live with the fake STT provider; a viewer joins via share
 * link, presses Read Aloud before text exists, reads along via the fake
 * recognition driver, catches up, and continues when new text arrives;
 * the creator ends the session and the completed page stays accessible.
 */

test("creator and viewer full live flow with read-aloud", async ({
  page,
  browser,
}) => {
  const { creatorPage, viewerUrl } = await startLiveSession(page);

  // viewer joins before any transcript exists
  const viewer = await openViewer(browser, viewerUrl);
  await expect(viewer.getByTestId("session-title")).toContainText(
    "E2E Live Session",
  );
  await expect(viewer.getByTestId("session-status")).toHaveAttribute(
    "data-status",
    /live|degraded/,
  );

  // Read Aloud pressed before the first sentence exists → waiting state
  await viewer.getByTestId("start-readaloud").click();
  await expect(viewer.getByTestId("waiting-banner")).toBeVisible();
  await expect(viewer.getByTestId("mic-indicator")).toBeVisible();

  // fake provider produces interim then final text from creator audio frames
  await expect(creatorPage.getByTestId("studio-interim")).not.toBeEmpty({
    timeout: 30_000,
  });
  await expect(creatorPage.getByTestId("studio-final")).toContainText(
    "Welcome everyone",
    { timeout: 30_000 },
  );

  // the viewer receives the same finalized text without refreshing
  await expect(viewer.getByTestId("final-transcript")).toContainText(
    "Welcome everyone",
    { timeout: 30_000 },
  );

  // pause the creator so the transcript stops growing
  await creatorPage.getByTestId("pause-session").click();
  await expect(creatorPage.getByTestId("resume-session")).toBeVisible();

  // viewer reads the first finalized sentence → cursor tracks and highlights
  const firstSentence = "welcome everyone to this global reading demonstration";
  await viewerSay(viewer, firstSentence);
  await expect(viewer.getByTestId("alignment-state")).toContainText("tracking");
  await expect(viewer.locator(".word-active")).toHaveCount(1);
  await expect(viewer.locator(".sentence-active").first()).toBeVisible();

  // read every remaining finalized sentence to catch up
  const finalText = await viewer.getByTestId("final-transcript").innerText();
  const sentences = finalText
    .split(".")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(1);
  for (const sentence of sentences) {
    await viewerSay(viewer, sentence.toLowerCase());
    await viewer.waitForTimeout(sentence.split(" ").length * 130 + 300);
  }
  await expect(viewer.getByTestId("caught-up-banner")).toBeVisible({
    timeout: 15_000,
  });

  // creator resumes → new text arrives → viewer can continue reading
  await creatorPage.getByTestId("resume-session").click();
  const before = (await viewer.getByTestId("final-transcript").innerText())
    .length;
  await expect
    .poll(
      async () =>
        (await viewer.getByTestId("final-transcript").innerText()).length,
      { timeout: 40_000 },
    )
    .toBeGreaterThan(before);

  // creator ends the session with confirmation
  await creatorPage.getByTestId("end-session").click();
  await creatorPage.getByTestId("confirm-end").click();
  await expect(viewer.getByTestId("session-status")).toHaveAttribute(
    "data-status",
    /completed|processing|ending/,
    { timeout: 20_000 },
  );

  // the completed transcript stays accessible at the same link after reload
  await viewer.reload();
  await expect(viewer.getByTestId("final-transcript")).toContainText(
    "Welcome everyone",
    { timeout: 20_000 },
  );
  await viewer.context().close();
});

test("viewer reconnect replays missed events without duplicates", async ({
  page,
  browser,
}) => {
  const { creatorPage, viewerUrl } = await startLiveSession(
    page,
    "E2E Reconnect Session",
  );
  const viewer = await openViewer(browser, viewerUrl);
  await expect(viewer.getByTestId("final-transcript")).toContainText(
    "Welcome everyone",
    { timeout: 30_000 },
  );

  // pause so content is stable, then reload the viewer (reconnect + replay)
  await creatorPage.getByTestId("pause-session").click();
  await viewer.waitForTimeout(1000);
  const before = await viewer.getByTestId("final-transcript").innerText();
  await viewer.reload();
  await expect(viewer.getByTestId("final-transcript")).toContainText(
    "Welcome everyone",
    { timeout: 20_000 },
  );
  const after = await viewer.getByTestId("final-transcript").innerText();
  expect(after.trim()).toBe(before.trim());

  // no duplicated finalized sentences
  const sentences = after
    .split(".")
    .map((s) => s.trim())
    .filter(Boolean);
  expect(new Set(sentences).size).toBe(sentences.length);
  await viewer.context().close();
});

test("viewer with denied microphone gets manual reading fallback", async ({
  page,
  browser,
}) => {
  const { viewerUrl } = await startLiveSession(page, "E2E Mic Denied Session");
  const viewer = await openViewer(browser, viewerUrl, {
    fakeSpeech: false,
    denyMicrophone: true,
  });
  await expect(viewer.getByTestId("final-transcript")).toContainText(
    "Welcome everyone",
    { timeout: 30_000 },
  );
  // Chromium exposes the Web Speech API; Firefox/WebKit builds do not, and
  // there the product correctly offers the manual-reading fallback instead.
  const speechAvailable = await viewer
    .getByTestId("start-readaloud")
    .isVisible()
    .catch(() => false);
  if (speechAvailable) {
    await viewer.getByTestId("start-readaloud").click();
    await expect(viewer.getByTestId("mic-denied")).toBeVisible();
  } else {
    await expect(viewer.getByTestId("readaloud-unsupported")).toBeVisible();
  }

  // manual fallback: clicking a word moves the reading cursor
  await viewer.locator('[data-word-index="3"]').first().click();
  await expect(viewer.locator(".word-active")).toHaveCount(1);
  await viewer.context().close();
});
