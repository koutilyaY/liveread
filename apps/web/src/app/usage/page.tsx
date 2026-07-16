"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "../../lib/api";

interface Usage {
  sessions: number;
  transcriptSegments: number;
  viewerSessions: number;
  recordingBytes: number;
  recordingDurationMs: number;
  provider: {
    provider: string;
    audioSecondsProcessed: number;
    streamsStarted: number;
  } | null;
}

export default function UsagePage() {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Usage>("/v1/usage")
      .then(setUsage)
      .catch((e) => setError((e as Error).message));
  }, []);

  return (
    <main className="mx-auto max-w-xl px-6 py-10">
      <h1 className="text-2xl font-bold">Usage</h1>
      {error && (
        <p role="alert" className="mt-4 text-red-600">
          {error}
        </p>
      )}
      {usage && (
        <dl className="mt-6 grid grid-cols-2 gap-4">
          {[
            ["Sessions", usage.sessions],
            ["Transcript segments", usage.transcriptSegments],
            ["Viewer sessions", usage.viewerSessions],
            [
              "Recording storage",
              `${(usage.recordingBytes / 1024 / 1024).toFixed(1)} MB`,
            ],
            [
              "Recording duration",
              `${Math.round(usage.recordingDurationMs / 60000)} min`,
            ],
            [
              "Provider audio processed",
              usage.provider
                ? `${Math.round(usage.provider.audioSecondsProcessed / 60)} min (${usage.provider.provider})`
                : "—",
            ],
          ].map(([label, value]) => (
            <div
              key={String(label)}
              className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900"
            >
              <dt className="text-xs text-zinc-500">{label}</dt>
              <dd className="mt-1 text-xl font-semibold">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="mt-8 text-sm">
        <Link href="/dashboard" className="underline">
          ← Back to dashboard
        </Link>
      </p>
    </main>
  );
}
