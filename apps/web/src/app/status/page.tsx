"use client";

import { useEffect, useState } from "react";
import { api } from "../../lib/api";

interface Readiness {
  ok: boolean;
  checks: Record<string, boolean>;
  stt: { primary: string; fallback: string; circuit: string };
}

export default function StatusPage() {
  const [ready, setReady] = useState<Readiness | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const load = () =>
      api<Readiness>("/readyz")
        .then((r) => {
          setReady(r);
          setError(false);
        })
        .catch(() => setError(true));
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  return (
    <main className="mx-auto max-w-xl px-6 py-12">
      <h1 className="text-3xl font-bold">System status</h1>
      {error && (
        <p
          role="alert"
          className="mt-6 rounded bg-red-50 p-4 text-red-700 dark:bg-red-950 dark:text-red-200"
        >
          The API is unreachable.
        </p>
      )}
      {ready && (
        <ul className="mt-6 space-y-2">
          <StatusRow name="Overall" ok={ready.ok} />
          {Object.entries(ready.checks).map(([name, ok]) => (
            <StatusRow key={name} name={name} ok={ok} />
          ))}
          <li className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white p-3 text-sm dark:border-zinc-700 dark:bg-zinc-900">
            <span>Transcription provider</span>
            <span className="text-zinc-500">
              {ready.stt.primary} (circuit: {ready.stt.circuit})
            </span>
          </li>
        </ul>
      )}
    </main>
  );
}

function StatusRow({ name, ok }: { name: string; ok: boolean }) {
  return (
    <li className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white p-3 text-sm dark:border-zinc-700 dark:bg-zinc-900">
      <span className="capitalize">{name}</span>
      <span className={ok ? "text-green-600" : "text-red-600"}>
        {ok ? "✓ operational" : "✗ unavailable"}
      </span>
    </li>
  );
}
