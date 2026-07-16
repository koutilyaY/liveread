"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api, API_URL, ApiRequestError } from "../../../../lib/api";

/**
 * Transcript editor: creator reviews finalized segments, corrects text
 * (optimistic concurrency via expectedRevision), inspects revision history,
 * plays the recording, downloads transcript/recording, deletes data.
 */

interface Segment {
  id: string;
  segmentIndex: number;
  currentRevision: number;
  status: string;
  text: string;
  startMs: number;
  endMs: number;
}

interface Revision {
  revisionNumber: number;
  source: string;
  previousText: string;
  newText: string;
  reason: string | null;
  createdAt: string;
  actor: { displayName: string } | null;
}

export default function TranscriptEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [segments, setSegments] = useState<Segment[] | null>(null);
  const [session, setSession] = useState<{
    title: string;
    status: string;
    shareId: string;
  } | null>(null);
  const [recording, setRecording] = useState<{
    url?: string;
    status: string;
  } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<{
    segmentId: string;
    revisions: Revision[];
  } | null>(null);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    const [t, s] = await Promise.all([
      api<{ segments: Segment[] }>(`/v1/sessions/${id}/transcript`),
      api<{ title: string; status: string; shareId: string }>(
        `/v1/sessions/${id}`,
      ),
    ]);
    setSegments(
      t.segments.filter((seg) => ["final", "corrected"].includes(seg.status)),
    );
    setSession(s);
    api<{ url?: string; status: string }>(`/v1/sessions/${id}/recording`)
      .then(setRecording)
      .catch(() => setRecording(null));
  }, [id]);

  useEffect(() => {
    void load().catch((err) => setError((err as Error).message));
  }, [load]);

  const saveCorrection = async (segment: Segment) => {
    setError(null);
    try {
      await api(`/v1/sessions/${id}/segments/${segment.id}/correct`, {
        method: "POST",
        body: JSON.stringify({
          text: editText,
          expectedRevision: segment.currentRevision,
        }),
      });
      setEditing(null);
      await load();
    } catch (err) {
      setError(
        err instanceof ApiRequestError && err.status === 409
          ? "This segment changed while you were editing. Reload and try again."
          : (err as Error).message,
      );
    }
  };

  const showHistory = async (segmentId: string) => {
    const res = await api<{ revisions: Revision[] }>(
      `/v1/sessions/${id}/segments/${segmentId}/revisions`,
    );
    setHistory({ segmentId, revisions: res.revisions });
  };

  const visible = segments?.filter(
    (s) => !search || s.text.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">{session?.title ?? "Transcript"}</h1>
        <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs dark:bg-zinc-800">
          {session?.status}
        </span>
        <Link href="/dashboard" className="ml-auto text-sm underline">
          Dashboard
        </Link>
      </header>

      {recording?.url && (
        <div className="mt-4">
          <audio controls src={recording.url} className="w-full" />
        </div>
      )}
      {recording &&
        recording.status !== "stored" &&
        recording.status !== "deleted" && (
          <p className="mt-2 text-sm text-zinc-500">
            Recording status: {recording.status}
          </p>
        )}

      <div className="mt-6 flex flex-wrap gap-2 text-sm">
        <a
          href={`${API_URL}/v1/sessions/${id}/transcript/export?format=txt`}
          className="rounded border border-zinc-300 px-3 py-1.5 hover:bg-zinc-100 dark:border-zinc-600 dark:hover:bg-zinc-800"
        >
          Download .txt
        </a>
        <a
          href={`${API_URL}/v1/sessions/${id}/transcript/export?format=vtt`}
          className="rounded border border-zinc-300 px-3 py-1.5 hover:bg-zinc-100 dark:border-zinc-600 dark:hover:bg-zinc-800"
        >
          Download .vtt
        </a>
        {recording?.url && (
          <a
            href={recording.url}
            download
            className="rounded border border-zinc-300 px-3 py-1.5 hover:bg-zinc-100 dark:border-zinc-600 dark:hover:bg-zinc-800"
          >
            Download recording
          </a>
        )}
        <input
          type="search"
          placeholder="Search transcript…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="ml-auto rounded border border-zinc-300 px-3 py-1.5 dark:border-zinc-600 dark:bg-zinc-800"
          aria-label="Search transcript"
        />
      </div>

      {error && (
        <p
          role="alert"
          className="mt-4 rounded bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-200"
        >
          {error}
        </p>
      )}

      <ol className="mt-6 space-y-2">
        {visible?.map((seg) => (
          <li
            key={seg.id}
            className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900"
            data-testid="segment"
          >
            {editing === seg.id ? (
              <div className="space-y-2">
                <textarea
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  rows={2}
                  className="w-full rounded border border-zinc-300 px-3 py-2 dark:border-zinc-600 dark:bg-zinc-800"
                  aria-label="Corrected text"
                  data-testid="edit-textarea"
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => void saveCorrection(seg)}
                    className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
                    data-testid="save-correction"
                  >
                    Save correction
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing(null)}
                    className="rounded border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-600"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-3">
                <span className="mt-1 shrink-0 text-xs tabular-nums text-zinc-400">
                  {formatTs(seg.startMs)}
                </span>
                <p className="flex-1">{seg.text}</p>
                <div className="flex shrink-0 gap-2 text-xs">
                  {seg.status === "corrected" && (
                    <span className="rounded bg-blue-100 px-1.5 py-0.5 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
                      corrected
                    </span>
                  )}
                  <button
                    type="button"
                    className="underline"
                    onClick={() => {
                      setEditing(seg.id);
                      setEditText(seg.text);
                    }}
                    data-testid="edit-segment"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="underline"
                    onClick={() => void showHistory(seg.id)}
                  >
                    History
                  </button>
                </div>
              </div>
            )}
            {history?.segmentId === seg.id && (
              <div className="mt-3 border-t border-zinc-200 pt-2 text-xs dark:border-zinc-700">
                {history.revisions.length === 0 ? (
                  <p className="text-zinc-500">No revisions recorded.</p>
                ) : (
                  history.revisions.map((r) => (
                    <p key={r.revisionNumber} className="py-0.5">
                      <strong>r{r.revisionNumber}</strong> ({r.source}
                      {r.actor ? ` by ${r.actor.displayName}` : ""}):{" "}
                      <del className="opacity-60">{r.previousText}</del> →{" "}
                      {r.newText}
                    </p>
                  ))
                )}
              </div>
            )}
          </li>
        ))}
      </ol>
      {segments?.length === 0 && (
        <p className="mt-6 text-zinc-500">No finalized transcript segments.</p>
      )}
    </main>
  );
}

function formatTs(ms: number): string {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${String(s).padStart(2, "0")}`;
}
