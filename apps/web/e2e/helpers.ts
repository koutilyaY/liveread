import type { Browser, Page } from "@playwright/test";
import { expect } from "@playwright/test";

/**
 * Deterministic media fixture: replaces getUserMedia with a real MediaStream
 * backed by an oscillator. Chromium's --use-fake-device-for-media-capture
 * hangs on macOS hosts, and this fixture also works identically in Firefox
 * and WebKit. Everything downstream (AudioWorklet capture, MediaRecorder,
 * permission UX) runs the real production code path.
 */
export async function installSyntheticMicrophone(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // patch the prototype: WebKit recreates the navigator.mediaDevices
    // wrapper between navigations, which drops instance-level overrides
    const original = MediaDevices.prototype.getUserMedia;
    MediaDevices.prototype.getUserMedia = async function (constraints) {
      if (!constraints || !constraints.audio) {
        return original.call(this, constraints);
      }
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.3;
      const dest = ctx.createMediaStreamDestination();
      osc.connect(gain);
      gain.connect(dest);
      osc.frequency.value = 440;
      osc.start();
      if (ctx.state === "suspended") void ctx.resume();
      return dest.stream;
    };
  });
}

export async function signupFreshCreator(page: Page): Promise<string> {
  await installSyntheticMicrophone(page);
  const email = `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
  await page.goto("/signup");
  await page.getByTestId("displayName").fill("E2E Creator");
  await page.getByTestId("email").fill(email);
  await page.getByTestId("password").fill("e2e-password-123");
  await page.getByTestId("auth-submit").click();
  await expect(page).toHaveURL(/dashboard/);
  return email;
}

export interface LiveSessionHandles {
  creatorPage: Page;
  sessionId: string;
  viewerUrl: string;
}

/** Sign up, create a session, pass preflight, and go live. */
export async function startLiveSession(
  page: Page,
  title = "E2E Live Session",
): Promise<LiveSessionHandles> {
  await signupFreshCreator(page);
  await page.getByTestId("new-session").click();
  await page.getByTestId("session-title-input").fill(title);
  await page.getByTestId("create-session").click();
  await expect(page).toHaveURL(/\/studio\//);
  const sessionId = page.url().split("/studio/")[1]!.split("?")[0]!;

  const viewerUrl = await page.evaluate(
    (id) => sessionStorage.getItem(`viewerUrl:${id}`),
    sessionId,
  );
  if (!viewerUrl) throw new Error("viewerUrl missing from sessionStorage");

  await page.getByTestId("probe-mic").click();
  await expect(page.getByTestId("start-speaking")).toBeEnabled();
  await page.getByTestId("start-speaking").click();
  // the studio has left preflight and is broadcasting. "Degraded" is a
  // legitimate landing state when the speech provider is unavailable — the
  // session is still live and still recording, which the provider-failure
  // spec asserts in detail.
  await expect(page.getByTestId("studio-status")).toContainText(
    /Live|Degraded/,
  );
  return { creatorPage: page, sessionId, viewerUrl };
}

/** Open the share link in a separate browser context (independent viewer). */
export async function openViewer(
  browser: Browser,
  viewerUrl: string,
  opts: { fakeSpeech?: boolean; denyMicrophone?: boolean } = {},
): Promise<Page> {
  // no permission grant needed: the synthetic fixture replaces getUserMedia
  // before any permission check (and Firefox has no grantable "microphone")
  const context = await browser.newContext();
  const page = await context.newPage();
  if (opts.denyMicrophone) {
    await page.addInitScript(() => {
      MediaDevices.prototype.getUserMedia = () =>
        Promise.reject(
          new DOMException("Permission denied", "NotAllowedError"),
        );
    });
  } else {
    await installSyntheticMicrophone(page);
  }
  const url = new URL(viewerUrl);
  if (opts.fakeSpeech !== false) url.searchParams.set("fakespeech", "1");
  await page.goto(url.toString());
  return page;
}

export async function viewerSay(page: Page, words: string): Promise<void> {
  await page.evaluate((w) => {
    if (!window.__lrFakeSpeech)
      throw new Error("fake speech driver not active");
    window.__lrFakeSpeech.say(w);
  }, words);
}

declare global {
  interface Window {
    __lrFakeSpeech?: { say: (words: string) => void };
  }
}
