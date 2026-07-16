"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "../../../lib/api";
import { useStudioStore } from "../../../store/studioStore";

/**
 * Creator studio: preflight checks, then live control (mic, pause/resume,
 * transcript, share link, recording, degradation warnings, end-session).
 */

interface Preflight {
  ok: boolean;
  checks: Record<string, boolean>;
  provider: string;
  languageSupported: boolean;
}

export default function StudioPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const store = useStudioStore();
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [micProbe, setMicProbe] = useState<"idle" | "ok" | "denied">("idle");
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [copied, setCopied] = useState(false);
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const runPreflight = useCallback(async () => {
    try {
      setPreflight(await api<Preflight>(`/v1/sessions/${id}/preflight`));
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, [id]);

  useEffect(() => {
    // read actions off the store rather than the render-scoped snapshot, so
    // this effect depends only on the session id
    void useStudioStore
      .getState()
      .load(id)
      .catch((err) => setLoadError((err as Error).message));
    void runPreflight();
    const url = sessionStorage.getItem(`viewerUrl:${id}`);
    if (url) setViewerUrl(url);
    return () => useStudioStore.getState().teardown();
  }, [id, runPreflight]);

  const probeMicrophone = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setMicProbe("ok");
    } catch {
      setMicProbe("denied");
    }
  };

  if (loadError) {
    return (
      <main className="mx-auto max-w-xl p-10">
        <p role="alert" className="text-red-600">
          {loadError}
        </p>
        <Link href="/dashboard" className="mt-4 inline-block underline">
          Back to dashboard
        </Link>
      </main>
    );
  }

  if (!store.session) {
    return <main className="p-10 text-zinc-500">Loading session…</main>;
  }

  const isLive = ["live", "paused", "degraded"].includes(store.status ?? "");
  const isCompleted =
    store.status === "completed" || store.status === "processing";
  const shareUrl =
    viewerUrl ?? `${window.location.origin}/s/${store.session.shareId}`;

  if (isCompleted) {
    return (
      <main className="mx-auto max-w-xl px-6 py-10">
        <h1 className="text-2xl font-bold">{store.session.title}</h1>
        <p className="mt-2 text-zinc-500">This session has ended.</p>
        <div className="mt-6 flex gap-3">
          <Link
            href={`/sessions/${id}/edit`}
            className="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
          >
            Review &amp; edit transcript
          </Link>
          <Link
            href="/dashboard"
            className="rounded border border-zinc-300 px-4 py-2 hover:bg-zinc-100 dark:border-zinc-600 dark:hover:bg-zinc-800"
          >
            Dashboard
          </Link>
        </div>
      </main>
    );
  }

  if (!isLive) {
    // ---------- PREFLIGHT ----------
    const httpsOk =
      window.location.protocol === "https:" ||
      ["localhost", "127.0.0.1"].includes(window.location.hostname);
    const wsOk = preflight?.checks["redis"] ?? false;
    const allOk = httpsOk && micProbe === "ok" && (preflight?.ok ?? false);
    return (
      <main className="mx-auto max-w-xl px-6 py-10">
        <h1 className="text-2xl font-bold">{store.session.title}</h1>
        <p className="mt-1 text-zinc-500">Preflight check</p>
        <ul className="mt-6 space-y-2" data-testid="preflight-checks">
          <Check ok={httpsOk} label="Secure connection (HTTPS)" />
          <Check
            ok={micProbe === "ok"}
            pending={micProbe === "idle"}
            label="Microphone permission"
            action={
              micProbe !== "ok" ? (
                <button
                  type="button"
                  onClick={() => void probeMicrophone()}
                  className="rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-600 dark:hover:bg-zinc-800"
                  data-testid="probe-mic"
                >
                  Test microphone
                </button>
              ) : undefined
            }
          />
          <Check
            ok={preflight?.checks["database"] ?? false}
            label="Server database"
          />
          <Check ok={wsOk} label="Realtime transport" />
          <Check
            ok={preflight?.checks["transcriptionProvider"] ?? false}
            label={`Transcription provider (${preflight?.provider ?? "…"})`}
          />
          <Check
            ok={preflight?.languageSupported ?? false}
            label="Selected language supported"
          />
        </ul>
        {micProbe === "denied" && (
          <p
            role="alert"
            className="mt-4 rounded bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-200"
            data-testid="mic-denied-help"
          >
            Microphone access was blocked. Allow it in your browser&apos;s site
            settings (usually the icon next to the address bar), then test
            again. Nothing is recorded during the test.
          </p>
        )}
        <button
          type="button"
          disabled={!allOk}
          onClick={() => void store.goLive()}
          className="mt-6 w-full rounded bg-green-600 px-4 py-3 text-lg font-medium text-white hover:bg-green-700 disabled:opacity-40"
          data-testid="start-speaking"
        >
          🎙 Start Speaking
        </button>
        {store.error && (
          <p role="alert" className="mt-3 text-sm text-red-600">
            {store.error}
          </p>
        )}
      </main>
    );
  }

  // ---------- LIVE STUDIO ----------
  return (
    <div className="flex h-dvh flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="font-semibold">{store.session.title}</h1>
        <span
          className={`rounded px-2 py-0.5 text-xs font-medium ${
            store.status === "live"
              ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
              : "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200"
          }`}
          data-testid="studio-status"
        >
          {store.status === "live"
            ? "● Live"
            : store.status === "paused"
              ? "Paused"
              : "Degraded"}
        </span>
        {store.connection !== "open" && (
          <span className="rounded bg-red-100 px-2 py-0.5 text-xs text-red-800 dark:bg-red-900 dark:text-red-200">
            {store.connection === "reconnecting"
              ? "Reconnecting…"
              : "Connecting…"}
          </span>
        )}
        <span className="text-xs text-zinc-500" data-testid="studio-viewers">
          {store.viewerCount} watching
        </span>
        <div className="ml-auto flex items-center gap-2">
          <MicMeter
            level={store.micLevel}
            active={store.micState === "active" && !store.muted}
          />
          {store.recordingState === "recording" && (
            <span
              className="flex items-center gap-1 text-xs text-red-600"
              data-testid="recording-indicator"
            >
              <span
                className="inline-block h-2 w-2 animate-pulse rounded-full bg-red-600"
                aria-hidden
              />
              REC {formatDuration(store.recordingSeconds)}
            </span>
          )}
        </div>
      </header>

      {store.degraded && (
        <p
          role="alert"
          className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
          data-testid="studio-degraded"
        >
          Live transcription is temporarily degraded. Audio recording continues;
          a recovery transcription will run after the session.
        </p>
      )}
      {store.recordingState === "failed" && (
        <p
          role="alert"
          className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          Uploading the recording failed.{" "}
          <button
            type="button"
            className="underline"
            onClick={() => store.emergencyDownload()}
          >
            Download a local copy now
          </button>{" "}
          so nothing is lost.
        </p>
      )}

      <main className="flex min-h-0 flex-1 flex-col gap-3 p-4 md:flex-row">
        <section
          className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-zinc-200 bg-white p-6 text-lg leading-relaxed dark:border-zinc-700 dark:bg-zinc-900"
          aria-label="Your live transcript"
          data-testid="studio-transcript"
        >
          {store.finalSegments.length === 0 &&
            store.interimSegments.length === 0 && (
              <p className="text-zinc-400">
                Start speaking — your words appear here.
              </p>
            )}
          <span data-testid="studio-final">
            {store.finalSegments.map((s) => (
              <span key={s.segmentId}>{s.text} </span>
            ))}
          </span>
          <span className="italic opacity-50" data-testid="studio-interim">
            {store.interimSegments.map((s) => (
              <span key={s.segmentId}>{s.text} </span>
            ))}
          </span>
        </section>

        <aside className="w-full shrink-0 space-y-4 md:w-72">
          <section className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900">
            <h2 className="mb-2 text-sm font-medium">Share link</h2>
            <div className="flex gap-2">
              <input
                readOnly
                value={shareUrl}
                className="w-full rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-800"
                aria-label="Viewer link"
                data-testid="share-url"
                onFocus={(e) => e.currentTarget.select()}
              />
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(shareUrl).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  });
                }}
                className="shrink-0 rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-600 dark:hover:bg-zinc-800"
              >
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
            {!viewerUrl && (
              <p className="mt-2 text-xs text-amber-600">
                Full link with its access key was shown when the session was
                created; use “Revoke &amp; regenerate” below if you lost it.
              </p>
            )}
            <button
              type="button"
              className="mt-2 text-xs text-red-600 underline"
              onClick={() =>
                void api<{ viewerUrl: string }>(
                  `/v1/sessions/${id}/revoke-share`,
                  {
                    method: "POST",
                    body: "{}",
                  },
                ).then((r) => setViewerUrl(r.viewerUrl))
              }
            >
              Revoke link &amp; generate a new one
            </button>
          </section>

          <section className="space-y-2 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900">
            <h2 className="text-sm font-medium">Controls</h2>
            <button
              type="button"
              onClick={() => store.setMuted(!store.muted)}
              className="w-full rounded border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-600 dark:hover:bg-zinc-800"
              data-testid="mute-toggle"
            >
              {store.muted ? "Unmute microphone" : "Mute microphone"}
            </button>
            {store.status === "live" || store.status === "degraded" ? (
              <button
                type="button"
                onClick={() => void store.pause()}
                className="w-full rounded border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-600 dark:hover:bg-zinc-800"
                data-testid="pause-session"
              >
                ⏸ Pause session
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void store.resume()}
                className="w-full rounded bg-green-600 px-3 py-2 text-sm text-white hover:bg-green-700"
                data-testid="resume-session"
              >
                ▶ Resume session
              </button>
            )}
            {confirmEnd ? (
              <div className="space-y-2 rounded border border-red-300 p-2">
                <p className="text-xs text-red-700 dark:text-red-300">
                  End the session for everyone? This cannot be undone.
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => void store.end()}
                    className="flex-1 rounded bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700"
                    data-testid="confirm-end"
                  >
                    End session
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmEnd(false)}
                    className="flex-1 rounded border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-600"
                  >
                    Keep going
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmEnd(true)}
                className="w-full rounded border border-red-300 px-3 py-2 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950"
                data-testid="end-session"
              >
                ⏹ End session
              </button>
            )}
          </section>

          <section className="rounded-lg border border-zinc-200 bg-white p-4 text-xs text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900">
            <p data-testid="frame-stats">
              Frames acknowledged: {store.ackSequence + 1}
              {store.droppedFrames > 0 && ` · dropped: ${store.droppedFrames}`}
            </p>
          </section>
        </aside>
      </main>
    </div>
  );
}

function Check({
  ok,
  pending,
  label,
  action,
}: {
  ok: boolean;
  pending?: boolean;
  label: string;
  action?: React.ReactNode;
}) {
  return (
    <li className="flex items-center gap-2 text-sm">
      <span aria-hidden>{pending ? "○" : ok ? "✅" : "❌"}</span>
      <span className="flex-1">{label}</span>
      {action}
    </li>
  );
}

function MicMeter({ level, active }: { level: number; active: boolean }) {
  const pct = Math.min(100, Math.round(level * 300));
  return (
    <div
      className="h-3 w-24 overflow-hidden rounded bg-zinc-200 dark:bg-zinc-700"
      role="meter"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="Microphone input level"
      data-testid="mic-meter"
    >
      <div
        className={`h-full transition-all ${active ? "bg-green-500" : "bg-zinc-400"}`}
        style={{ width: `${active ? Math.max(4, pct) : 0}%` }}
      />
    </div>
  );
}

function formatDuration(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
