/**
 * Live verification of the REAL streaming speech provider.
 *
 * Everything else in this repo is tested against the deterministic fake
 * provider, which proves the pipeline but says nothing about whether real
 * recognition works. This script closes that gap: it speaks a known sentence,
 * streams it through the production adapter at real-time pace, and reports
 * what came back plus the latencies the spec sets objectives for.
 *
 *   DEEPGRAM_API_KEY=... pnpm --filter @liveread/api verify:real-stt
 *   # or against your own recording:
 *   DEEPGRAM_API_KEY=... pnpm --filter @liveread/api verify:real-stt -- my.wav
 *
 * Audio: uses the file you pass, otherwise synthesizes speech with `say`
 * (macOS) or `espeak` (Linux). Requires 16 kHz mono 16-bit PCM WAV.
 *
 * This costs a few seconds of provider time (fractions of a cent).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeepgramSttProvider } from "../src/stt/deepgram.js";
import type { SttFinalResult, SttInterimResult } from "../src/stt/provider.js";

const SPOKEN =
  "Today I want to explain how rivers shape the land around them. " +
  "Water always moves downhill under the pull of gravity.";

const SAMPLE_RATE = 16000;
const FRAME_MS = 100;
const BYTES_PER_FRAME = (SAMPLE_RATE * 2 * FRAME_MS) / 1000; // mono s16le

function fail(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function which(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Produce 16 kHz mono s16le WAV of SPOKEN, or use a supplied file. */
function getAudio(): { pcm: Buffer; source: string; cleanup?: () => void } {
  const supplied = process.argv[2];
  if (supplied) {
    if (!existsSync(supplied)) fail(`file not found: ${supplied}`);
    return { pcm: stripWavHeader(readFileSync(supplied)), source: supplied };
  }

  const out = join(tmpdir(), `liveread-stt-${process.pid}.wav`);
  if (which("say")) {
    execFileSync("say", [
      "-o",
      out,
      "--data-format=LEI16@16000",
      "--channels=1",
      SPOKEN,
    ]);
  } else if (which("espeak")) {
    execFileSync("espeak", ["-w", out, "-s", "150", SPOKEN]);
  } else {
    fail(
      "no speech synthesizer found (need `say` on macOS or `espeak` on Linux).\n" +
        "  Pass a 16kHz mono WAV instead:  verify:real-stt -- path/to/audio.wav",
    );
  }
  return {
    pcm: stripWavHeader(readFileSync(out)),
    source: `synthesized: "${SPOKEN.slice(0, 48)}…"`,
    cleanup: () => unlinkSync(out),
  };
}

/** Return the PCM payload of a RIFF/WAVE file by walking its chunks. */
function stripWavHeader(buf: Buffer): Buffer {
  if (buf.toString("ascii", 0, 4) !== "RIFF") return buf; // assume raw PCM
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "data") return buf.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  fail("no data chunk in WAV file");
}

/** Rough overlap between what was spoken and what came back. */
function wordOverlap(expected: string, actual: string): number {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, "")
      .split(/\s+/)
      .filter(Boolean);
  const want = norm(expected);
  const got = new Set(norm(actual));
  if (want.length === 0) return 0;
  return want.filter((w) => got.has(w)).length / want.length;
}

async function main(): Promise<void> {
  const apiKey = process.env["DEEPGRAM_API_KEY"];
  if (!apiKey) {
    fail(
      "DEEPGRAM_API_KEY is not set.\n" +
        "  This script deliberately does NOT fall back to the fake provider —\n" +
        "  its only purpose is to exercise the real one.",
    );
  }

  const provider = new DeepgramSttProvider(apiKey);

  process.stdout.write("health check … ");
  if (!(await provider.healthCheck())) {
    fail("healthCheck() failed — key rejected or network unreachable.");
  }
  console.log("ok");

  const audio = getAudio();
  const frames = Math.ceil(audio.pcm.length / BYTES_PER_FRAME);
  const durationMs = (audio.pcm.length / (SAMPLE_RATE * 2)) * 1000;
  console.log(`audio: ${audio.source}`);
  console.log(
    `       ${(audio.pcm.length / 1024).toFixed(0)} KiB, ${(durationMs / 1000).toFixed(1)}s, ${frames} frames\n`,
  );

  const interims: SttInterimResult[] = [];
  const finals: SttFinalResult[] = [];
  const errors: Error[] = [];
  let firstInterimMs: number | null = null;
  let firstFinalMs: number | null = null;
  const t0 = Date.now();

  const stream = await provider.startStream(
    {
      streamId: "verify",
      languageCode: "en-US",
      sampleRate: SAMPLE_RATE,
      channelCount: 1,
      encoding: "pcm_s16le",
    },
    {
      onInterim: (r) => {
        if (firstInterimMs === null) firstInterimMs = Date.now() - t0;
        interims.push(r);
        process.stdout.write(`\r  interim: ${r.text.slice(-70).padEnd(72)}`);
      },
      onFinal: (r) => {
        if (firstFinalMs === null) firstFinalMs = Date.now() - t0;
        finals.push(r);
        process.stdout.write(`\r  FINAL:   ${r.text}\n`);
      },
      onError: (e) => errors.push(e),
      onClose: () => {},
    },
  );

  // stream at real-time pace, as a live microphone would
  for (let i = 0; i < frames; i++) {
    const frame = audio.pcm.subarray(
      i * BYTES_PER_FRAME,
      (i + 1) * BYTES_PER_FRAME,
    );
    stream.sendAudioFrame(Buffer.from(frame), i * FRAME_MS);
    await new Promise((r) => setTimeout(r, FRAME_MS));
  }
  await stream.finishStream();
  await new Promise((r) => setTimeout(r, 1500)); // let trailing finals land
  audio.cleanup?.();

  const transcript = finals
    .map((f) => f.text)
    .join(" ")
    .trim();
  const usage = provider.usageMetadata();

  console.log("\n─── results ─────────────────────────────────────────────");
  console.log(`interim results   : ${interims.length}`);
  console.log(`final segments    : ${finals.length}`);
  console.log(
    `first interim     : ${firstInterimMs ?? "—"} ms   (target <1000)`,
  );
  console.log(`first final       : ${firstFinalMs ?? "—"} ms`);
  console.log(`audio billed      : ${usage.audioSecondsProcessed.toFixed(1)}s`);
  const st = stream.stats?.();
  if (st) console.log(`dropped frames    : ${st.droppedFrames}`);
  console.log(`\ntranscript:\n  ${transcript || "(empty)"}`);

  if (errors.length) {
    console.log(`\nerrors: ${errors.map((e) => e.message).join("; ")}`);
  }

  let ok = true;
  if (!transcript) {
    console.log("\n✗ no transcript returned");
    ok = false;
  }
  if (!process.argv[2]) {
    // only meaningful when we know what was spoken
    const overlap = wordOverlap(SPOKEN, transcript);
    console.log(`word overlap      : ${(overlap * 100).toFixed(0)}%`);
    if (overlap < 0.7) {
      console.log(
        "✗ recognition overlap below 70% — investigate before trusting this path",
      );
      ok = false;
    }
  }
  if (finals.length > 6) {
    console.log(
      `✗ ${finals.length} final segments for ~2 sentences — utterances look fragmented`,
    );
    ok = false;
  }

  console.log(
    ok ? "\n✓ real provider path works\n" : "\n✗ verification failed\n",
  );
  process.exit(ok ? 0 : 1);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
