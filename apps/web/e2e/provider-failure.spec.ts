import { expect, test } from "@playwright/test";
import { openViewer, startLiveSession } from "./helpers";

/**
 * Acceptance criteria 27/28 through the real UI: when the speech provider
 * fails, the creator and viewers must SEE a degraded state, recording must
 * keep going, and no transcript may be fabricated to cover the gap.
 *
 * Requires the API to run with FAKE_STT_FAIL_MODE=start, which makes the fake
 * provider's startStream reject. `make test-provider-failure` handles that;
 * the test skips (loudly) rather than silently passing if the API is not in
 * that mode.
 */

const FAILURE_MODE = process.env["E2E_PROVIDER_FAILURE"] === "1";

test.describe("provider failure", () => {
  test.skip(
    !FAILURE_MODE,
    "requires the API started with FAKE_STT_FAIL_MODE — run `make test-provider-failure`",
  );

  test("degraded state is visible to creator and viewer, recording continues, no fabricated text", async ({
    page,
    browser,
  }) => {
    const { creatorPage, viewerUrl } = await startLiveSession(
      page,
      "Provider Failure Session",
    );

    // creator sees the degradation banner with honest wording
    await expect(creatorPage.getByTestId("studio-degraded")).toBeVisible({
      timeout: 30_000,
    });
    await expect(creatorPage.getByTestId("studio-degraded")).toContainText(
      "Audio recording continues",
    );

    // recording keeps running despite the transcription outage
    await expect(creatorPage.getByTestId("recording-indicator")).toBeVisible();

    // no transcript is fabricated to cover the gap
    await expect(creatorPage.getByTestId("studio-final")).toBeEmpty();
    await expect(creatorPage.getByTestId("studio-interim")).toBeEmpty();

    // viewers see the degraded state too, and an empty (not invented) transcript
    const viewer = await openViewer(browser, viewerUrl);
    await expect(viewer.getByTestId("degraded-banner")).toBeVisible({
      timeout: 20_000,
    });
    await expect(viewer.getByTestId("transcript-empty")).toBeVisible();

    // the session can still be ended cleanly
    await creatorPage.getByTestId("end-session").click();
    await creatorPage.getByTestId("confirm-end").click();
    await expect(viewer.getByTestId("session-status")).toHaveAttribute(
      "data-status",
      /completed|processing|ending/,
      { timeout: 20_000 },
    );
    await viewer.context().close();
  });
});
