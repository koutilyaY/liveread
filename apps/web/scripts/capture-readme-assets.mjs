/**
 * Captures the README's visual assets from the RUNNING app (no mockups):
 *   docs/assets/viewer-read-aloud.png  — viewer mid-read, word+sentence highlight
 *   docs/assets/creator-studio.png     — live studio with interim/final text
 *   docs/assets/read-aloud.webm        — raw video for the README gif
 *
 * Prereqs: full stack up (make up), demo seeded (make seed).
 * Run:     node apps/web/scripts/capture-readme-assets.mjs
 * Then:    convert the webm with ffmpeg (see Makefile `readme-assets`).
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const assets = join(root, "docs", "assets");
mkdirSync(assets, { recursive: true });

const WEB = process.env.WEB_URL ?? "http://localhost:3000";
const DEMO = `${WEB}/s/demo-reading-2026?fakespeech=1#demo-share-token-public`;

/** Same synthetic mic used by the E2E suite — real MediaStream, no hardware. */
const syntheticMic = () => {
  const original = MediaDevices.prototype.getUserMedia;
  MediaDevices.prototype.getUserMedia = async function (constraints) {
    if (!constraints || !constraints.audio) return original.call(this, constraints);
    try {
      const ctx = new AudioContext();
      if (ctx.state === "suspended") await ctx.resume();
      if (ctx.state !== "running") throw new Error("no_audio_backend");
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.3;
      const dest = ctx.createMediaStreamDestination();
      osc.connect(gain);
      gain.connect(dest);
      osc.frequency.value = 440;
      osc.start();
      return dest.stream;
    } catch {
      return original.call(this, constraints);
    }
  };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Feed the deterministic fake recognizer, phrase by phrase, like a reader. */
async function readAloud(page, phrases, paceMs) {
  for (const phrase of phrases) {
    await page.evaluate((w) => window.__lrFakeSpeech.say(w), phrase);
    await sleep(paceMs);
  }
}

const PHRASES = [
  "welcome everyone to this global reading demonstration",
  "today we are going to explore how live text can follow your voice",
  "the words you see appear moments after they are spoken",
  "interim text may change while a sentence is still forming",
  "once a sentence is finalized it becomes stable and readable",
];

async function captureViewerStill(browser) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
  });
  const page = await ctx.newPage();
  await page.addInitScript(syntheticMic);
  await page.goto(DEMO);
  await page.getByTestId("start-readaloud").click();
  await page.waitForFunction(() => Boolean(window.__lrFakeSpeech));
  await readAloud(page, PHRASES.slice(0, 3), 700);
  await sleep(600); // let highlight + autoscroll settle
  await page.screenshot({ path: join(assets, "viewer-read-aloud.png") });
  await ctx.close();
  console.log("✓ viewer-read-aloud.png");
}

async function captureStudio(browser) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
  });
  const page = await ctx.newPage();
  await page.addInitScript(syntheticMic);
  // fresh creator → session → live, exactly like the E2E helper
  await page.goto(`${WEB}/signup`);
  await page.getByTestId("displayName").fill("Ada Reader");
  await page
    .getByTestId("email")
    .fill(`readme-${Date.now()}@assets.local`);
  await page.getByTestId("password").fill("readme-assets-pass-1");
  await page.getByTestId("auth-submit").click();
  await page.waitForURL(/dashboard/);
  await page.getByTestId("new-session").click();
  await page.getByTestId("session-title-input").fill("Field Notes on Rivers — Live");
  await page.getByTestId("create-session").click();
  await page.waitForURL(/\/studio\//);
  await page.getByTestId("probe-mic").click();
  await page.getByTestId("start-speaking").click();
  // let the fake provider produce interim + at least one final sentence
  await page.waitForSelector('[data-testid="studio-final"] p, [data-testid="studio-final"] span', { timeout: 30_000 }).catch(() => {});
  await sleep(9_000);
  await page.screenshot({ path: join(assets, "creator-studio.png") });
  await ctx.close();
  console.log("✓ creator-studio.png");
}

async function captureGifSource(browser) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    colorScheme: "dark",
    recordVideo: { dir: assets, size: { width: 1280, height: 720 } },
  });
  const page = await ctx.newPage();
  await page.addInitScript(syntheticMic);
  await page.goto(DEMO);
  await sleep(800);
  await page.getByTestId("start-readaloud").click();
  await page.waitForFunction(() => Boolean(window.__lrFakeSpeech));
  await sleep(700);
  await readAloud(page, PHRASES, 1500);
  await sleep(1200);
  const video = page.video();
  await ctx.close(); // flushes the recording
  const path = await video.path();
  const { renameSync } = await import("node:fs");
  renameSync(path, join(assets, "read-aloud.webm"));
  console.log("✓ read-aloud.webm");
}

const browser = await chromium.launch();
try {
  await captureViewerStill(browser);
  await captureStudio(browser);
  await captureGifSource(browser);
} finally {
  await browser.close();
}
