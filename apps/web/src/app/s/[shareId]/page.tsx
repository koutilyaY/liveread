"use client";

import { use, useEffect, useState } from "react";
import { api } from "../../../lib/api";
import { useViewerStore } from "../../../store/viewerStore";
import { TranscriptView } from "../../../components/TranscriptView";

/**
 * Viewer page: live session (transcript + Read Aloud Mode) and, after the
 * creator ends, the completed session (recording playback + transcript).
 * The share token travels in the URL fragment and never reaches any server
 * log; it is exchanged once for a scoped viewer token.
 */

export default function ViewerPage({
  params,
}: {
  params: Promise<{ shareId: string }>;
}) {
  const { shareId } = use(params);
  const store = useViewerStore();
  const [passcodeInput, setPasscodeInput] = useState("");
  const [shareToken, setShareToken] = useState<string | null>(null);
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);

  useEffect(() => {
    const token = window.location.hash.slice(1);
    if (!token) return;
    setShareToken(token);
    void useViewerStore.getState().access(shareId, token);
    const cleanup = () => useViewerStore.getState().disconnect();
    window.addEventListener("beforeunload", cleanup);
    return () => {
      window.removeEventListener("beforeunload", cleanup);
      cleanup();
    };
  }, [shareId]);

  const completed =
    store.status === "completed" || store.status === "processing";

  useEffect(() => {
    if (completed && store.viewerToken && !recordingUrl) {
      api<{ url: string }>(
        `/v1/share/${shareId}/recording?token=${encodeURIComponent(store.viewerToken)}`,
      )
        .then((r) => setRecordingUrl(r.url))
        .catch(() => {});
    }
  }, [completed, store.viewerToken, shareId, recordingUrl]);

  if (!shareToken) {
    return (
      <Shell>
        <p role="alert" className="text-red-600">
          This link is incomplete — it is missing its access key. Ask the
          creator to share the full link.
        </p>
      </Shell>
    );
  }

  if (store.accessError) {
    return (
      <Shell>
        <div role="alert" className="space-y-3">
          <h1 className="text-xl font-semibold">This session is unavailable</h1>
          <p className="text-zinc-600 dark:text-zinc-300">
            {store.accessError}
          </p>
          <p className="text-sm text-zinc-500">
            The link may have expired or been revoked by the creator.
          </p>
        </div>
      </Shell>
    );
  }

  if (store.needsPasscode) {
    return (
      <Shell>
        <form
          className="mx-auto max-w-sm space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void store.access(shareId, shareToken, passcodeInput);
          }}
        >
          <h1 className="text-xl font-semibold">
            This session needs a passcode
          </h1>
          <label className="block">
            <span className="mb-1 block text-sm">Passcode</span>
            <input
              type="password"
              value={passcodeInput}
              onChange={(e) => setPasscodeInput(e.target.value)}
              className="w-full rounded border border-zinc-300 px-3 py-2 dark:border-zinc-600 dark:bg-zinc-800"
              autoFocus
            />
          </label>
          <button
            type="submit"
            className="w-full rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
          >
            Enter session
          </button>
        </form>
      </Shell>
    );
  }

  if (!store.meta) {
    return (
      <Shell>
        <p className="text-zinc-500">Connecting to the session…</p>
      </Shell>
    );
  }

  const alignment = store.alignment;
  const caughtUp = alignment?.state === "caught_up";
  const waiting =
    store.readAloudActive &&
    (alignment === null ||
      alignment.state === "waiting" ||
      store.finalSegments.length === 0);

  return (
    <div className="flex h-dvh flex-col bg-zinc-50 dark:bg-zinc-950">
      <header className="flex flex-wrap items-center gap-3 border-b border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="text-lg font-semibold" data-testid="session-title">
          {store.meta.title}
        </h1>
        <StatusPill status={store.status ?? "live"} />
        <ConnectionPill state={store.connection} />
        {!store.creatorConnected && !completed && (
          <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-900 dark:text-amber-200">
            Speaker reconnecting…
          </span>
        )}
        {store.degraded && (
          <span
            role="status"
            className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-900 dark:text-amber-200"
            data-testid="degraded-banner"
          >
            Live transcription is temporarily degraded
          </span>
        )}
        <span
          className="ml-auto text-xs text-zinc-500"
          data-testid="viewer-count"
        >
          {store.viewerCount > 0 ? `${store.viewerCount} watching` : ""}
        </span>
      </header>

      {completed && recordingUrl && (
        <div className="border-b border-zinc-200 bg-white px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
          <audio
            controls
            src={recordingUrl}
            className="w-full"
            data-testid="recording-player"
          >
            Your browser cannot play this recording.
          </audio>
          <p className="mt-1 text-xs text-zinc-500">
            Automated transcription can contain errors. The creator may have
            corrected parts of this transcript.
          </p>
        </div>
      )}

      <main className="flex min-h-0 flex-1 flex-col gap-3 p-3 sm:p-4 md:flex-row">
        {/* On a phone the stacked control panel was taking two thirds of the
            screen, leaving the reading surface ~270px of 812. Give reading a
            floor of 58% of the viewport; the controls sit a scroll below. */}
        <div className="min-h-[58svh] flex-1 md:min-h-0">
          <TranscriptView
            finalSegments={store.finalSegments}
            interimSegments={completed ? [] : store.interimSegments}
            segmentTokens={store.segmentTokens}
            activeWordIndex={alignment?.matchedWordIndex ?? -1}
            activeSentenceIndex={alignment?.matchedSentenceIndex ?? -1}
            autoScroll={store.autoScroll}
            fontScale={store.fontScale}
            lineSpacing={store.lineSpacing}
            highContrast={store.highContrast}
            readAloudActive={store.readAloudActive || alignment !== null}
            onManualJump={(i) => store.manualJump(i)}
          />
        </div>

        <aside className="w-full shrink-0 space-y-4 md:w-72">
          <section className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900">
            <h2 className="mb-2 font-medium">Read Aloud Mode</h2>
            {!store.recognitionSupported ? (
              <p
                className="text-sm text-zinc-500"
                data-testid="readaloud-unsupported"
              >
                Voice following is not supported in this browser. You can still
                read the transcript and move the cursor by tapping a sentence.
              </p>
            ) : store.readAloudActive ? (
              <div className="space-y-2">
                <p
                  className="flex items-center gap-2 text-sm"
                  data-testid="mic-indicator"
                >
                  <span
                    className="inline-block h-2 w-2 animate-pulse rounded-full bg-red-500"
                    aria-hidden
                  />
                  Microphone active — your voice is processed in this browser
                  only and never stored.
                </p>
                <p className="text-sm" data-testid="alignment-state">
                  Status: <strong>{alignment?.state ?? "waiting"}</strong>
                </p>
                {waiting && (
                  <p
                    className="rounded bg-blue-50 p-2 text-sm text-blue-800 dark:bg-blue-950 dark:text-blue-200"
                    data-testid="waiting-banner"
                  >
                    Read Aloud is ready. Waiting for the first readable
                    sentence.
                  </p>
                )}
                {caughtUp && (
                  <p
                    className="rounded bg-green-50 p-2 text-sm text-green-800 dark:bg-green-950 dark:text-green-200"
                    data-testid="caught-up-banner"
                  >
                    You have caught up with the speaker. Waiting for the next
                    sentence.
                  </p>
                )}
                {alignment?.state === "lost" && (
                  <p
                    className="rounded bg-amber-50 p-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200"
                    data-testid="lost-banner"
                  >
                    We lost your place. Keep reading, or tap the sentence you
                    are on.
                  </p>
                )}
                <ReadingProgress
                  current={alignment?.matchedWordIndex ?? -1}
                  total={store.totalWords}
                />
                <button
                  type="button"
                  onClick={() => store.stopReadAloud()}
                  className="w-full rounded border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-600 dark:hover:bg-zinc-800"
                  data-testid="stop-readaloud"
                >
                  Stop Read Aloud
                </button>
              </div>
            ) : store.permission === "denied" ? (
              <div className="space-y-2" data-testid="mic-denied">
                <p className="text-sm text-red-600">
                  Microphone access was blocked. Voice following needs it to
                  hear where you are reading.
                </p>
                <p className="text-sm text-zinc-500">
                  Allow the microphone in your browser&apos;s site settings and
                  try again — or read manually and tap any sentence to move the
                  cursor.
                </p>
                <button
                  type="button"
                  onClick={() => void store.startReadAloud()}
                  className="w-full rounded bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700"
                >
                  Try again
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-sm text-zinc-500">
                  Read the text out loud and the page follows your voice. Your
                  audio never leaves this browser.
                </p>
                <button
                  type="button"
                  onClick={() => void store.startReadAloud()}
                  className="w-full rounded bg-blue-600 px-3 py-2 text-white hover:bg-blue-700"
                  data-testid="start-readaloud"
                >
                  ▶ Read Aloud Mode
                </button>
              </div>
            )}
          </section>

          <section className="rounded-lg border border-zinc-200 bg-white p-4 text-sm dark:border-zinc-700 dark:bg-zinc-900">
            <h2 className="mb-2 font-medium">Display</h2>
            <div className="space-y-3">
              <label className="flex items-center justify-between gap-2">
                Font size
                <input
                  type="range"
                  min={0.8}
                  max={2}
                  step={0.1}
                  value={store.fontScale}
                  onChange={(e) => store.setFontScale(Number(e.target.value))}
                  aria-label="Font size"
                />
              </label>
              <label className="flex items-center justify-between gap-2">
                Line spacing
                <input
                  type="range"
                  min={1.4}
                  max={2.6}
                  step={0.2}
                  value={store.lineSpacing}
                  onChange={(e) => store.setLineSpacing(Number(e.target.value))}
                  aria-label="Line spacing"
                />
              </label>
              <label className="flex items-center justify-between">
                High contrast
                <input
                  type="checkbox"
                  checked={store.highContrast}
                  onChange={(e) => store.setHighContrast(e.target.checked)}
                />
              </label>
              <label className="flex items-center justify-between">
                Auto-scroll
                <input
                  type="checkbox"
                  checked={store.autoScroll}
                  onChange={(e) => store.setAutoScroll(e.target.checked)}
                  data-testid="autoscroll-toggle"
                />
              </label>
            </div>
          </section>

          <p className="px-1 text-xs text-zinc-600 dark:text-zinc-400">
            Near-real-time transcription — interim text may be corrected.{" "}
            <a href={`/report?s=${shareId}`} className="underline">
              Report abuse
            </a>
          </p>
        </aside>
      </main>

      <div aria-live="polite" className="sr-only" data-testid="live-region">
        {caughtUp
          ? "You have caught up with the speaker."
          : store.degraded
            ? "Live transcription is temporarily degraded."
            : ""}
      </div>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-zinc-50 p-6 dark:bg-zinc-950">
      <div className="w-full max-w-lg rounded-lg border border-zinc-200 bg-white p-8 dark:border-zinc-700 dark:bg-zinc-900">
        {children}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const styles: Record<string, string> = {
    live: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
    paused: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
    degraded:
      "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
    completed: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
    processing: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  };
  const labels: Record<string, string> = {
    live: "● Live",
    paused: "Paused",
    degraded: "Live (degraded)",
    completed: "Ended",
    processing: "Processing",
    ending: "Ending…",
    preflight: "Not started yet",
  };
  return (
    <span
      className={`rounded px-2 py-0.5 text-xs font-medium ${styles[status] ?? "bg-zinc-100 text-zinc-600"}`}
      data-testid="session-status"
      data-status={status}
    >
      {labels[status] ?? status}
    </span>
  );
}

function ConnectionPill({ state }: { state: string }) {
  if (state === "open") return null;
  return (
    <span
      role="status"
      className="rounded bg-red-100 px-2 py-0.5 text-xs text-red-800 dark:bg-red-900 dark:text-red-200"
      data-testid="connection-state"
    >
      {state === "reconnecting" ? "Reconnecting…" : "Connecting…"}
    </span>
  );
}

function ReadingProgress({
  current,
  total,
}: {
  current: number;
  total: number;
}) {
  const pct =
    total > 0 && current >= 0
      ? Math.min(100, Math.round(((current + 1) / total) * 100))
      : 0;
  return (
    <div>
      <div
        className="h-2 w-full overflow-hidden rounded bg-zinc-200 dark:bg-zinc-700"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Reading progress"
      >
        <div className="h-full bg-blue-600" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1 text-xs text-zinc-500">{pct}% read</p>
    </div>
  );
}
