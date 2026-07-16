"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, ApiRequestError } from "../../lib/api";

interface SessionItem {
  id: string;
  title: string;
  status: string;
  shareId: string;
  createdAt: string;
  startedAt: string | null;
}

export default function DashboardPage() {
  const router = useRouter();
  const [me, setMe] = useState<{
    displayName: string;
    emailVerified: boolean;
  } | null>(null);
  const [sessions, setSessions] = useState<SessionItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const user = await api<{ displayName: string; emailVerified: boolean }>(
          "/v1/auth/me",
        );
        setMe(user);
        const list = await api<{ items: SessionItem[] }>("/v1/sessions");
        setSessions(list.items);
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 401) {
          router.push("/signin");
          return;
        }
        setError((err as Error).message);
      }
    })();
  }, [router]);

  if (error) {
    return (
      <main className="mx-auto max-w-2xl p-8">
        <p role="alert" className="text-red-600">
          {error}
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          {me && (
            <p className="text-sm text-zinc-500">
              Signed in as {me.displayName}
            </p>
          )}
        </div>
        <nav className="flex items-center gap-3 text-sm">
          <Link href="/usage" className="underline">
            Usage
          </Link>
          <Link href="/account" className="underline">
            Account
          </Link>
          <button
            type="button"
            className="underline"
            onClick={() =>
              void api("/v1/auth/logout", { method: "POST", body: "{}" }).then(
                () => router.push("/"),
              )
            }
          >
            Sign out
          </button>
        </nav>
      </header>

      {me && !me.emailVerified && (
        <p className="mt-4 rounded bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          Verify your email address to start live sessions — check your inbox
          for the verification link.
        </p>
      )}

      <div className="mt-8">
        <Link
          href="/sessions/new"
          className="inline-block rounded bg-blue-600 px-5 py-2.5 text-white hover:bg-blue-700"
          data-testid="new-session"
        >
          + New Live Session
        </Link>
      </div>

      <section className="mt-8">
        <h2 className="mb-3 font-semibold">Your sessions</h2>
        {sessions === null ? (
          <p className="text-zinc-500">Loading…</p>
        ) : sessions.length === 0 ? (
          <p className="text-zinc-500">
            No sessions yet — create your first one.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white dark:divide-zinc-700 dark:border-zinc-700 dark:bg-zinc-900">
            {sessions.map((s) => (
              <li key={s.id} className="flex items-center gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <Link
                    href={
                      s.status === "completed" || s.status === "processing"
                        ? `/sessions/${s.id}/edit`
                        : `/studio/${s.id}`
                    }
                    className="font-medium hover:underline"
                  >
                    {s.title}
                  </Link>
                  <p className="text-xs text-zinc-500">
                    {new Date(s.createdAt).toLocaleString()} · {s.status}
                  </p>
                </div>
                {["preflight", "live", "paused", "degraded"].includes(
                  s.status,
                ) && (
                  <Link
                    href={`/studio/${s.id}`}
                    className="rounded border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-600 dark:hover:bg-zinc-800"
                  >
                    Open studio
                  </Link>
                )}
                {(s.status === "completed" || s.status === "processing") && (
                  <Link
                    href={`/sessions/${s.id}/edit`}
                    className="rounded border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-600 dark:hover:bg-zinc-800"
                  >
                    Transcript
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
