"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, API_URL, ApiRequestError } from "../../lib/api";

export default function AccountPage() {
  const router = useRouter();
  const [me, setMe] = useState<{
    email: string;
    displayName: string;
    emailVerified: boolean;
  } | null>(null);
  const [deletePassword, setDeletePassword] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<typeof me>("/v1/auth/me")
      .then(setMe)
      .catch((err) => {
        if (err instanceof ApiRequestError && err.status === 401) {
          router.push("/signin");
        }
      });
  }, [router]);

  if (!me) return <main className="p-10 text-zinc-500">Loading…</main>;

  return (
    <main className="mx-auto max-w-xl px-6 py-10">
      <h1 className="text-2xl font-bold">Account</h1>
      <dl className="mt-6 space-y-2 text-sm">
        <div className="flex justify-between">
          <dt className="text-zinc-500">Email</dt>
          <dd>
            {me.email}{" "}
            {me.emailVerified ? (
              <span className="text-green-600">verified</span>
            ) : (
              <span className="text-amber-600">unverified</span>
            )}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-zinc-500">Display name</dt>
          <dd>{me.displayName}</dd>
        </div>
      </dl>

      <section className="mt-10">
        <h2 className="font-semibold">Your data</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Export everything LiveRead stores about you and your sessions.
        </p>
        <a
          href={`${API_URL}/v1/privacy/export`}
          className="mt-2 inline-block rounded border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-600 dark:hover:bg-zinc-800"
        >
          Download data export (JSON)
        </a>
      </section>

      <section className="mt-10 rounded-lg border border-red-200 p-4 dark:border-red-900">
        <h2 className="font-semibold text-red-600">Delete account</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Permanently deletes your sessions, transcripts, and recordings. This
          cannot be undone.
        </p>
        {confirmDelete ? (
          <div className="mt-3 space-y-2">
            <input
              type="password"
              placeholder="Confirm your password"
              value={deletePassword}
              onChange={(e) => setDeletePassword(e.target.value)}
              className="w-full rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-800"
            />
            {error && (
              <p role="alert" className="text-sm text-red-600">
                {error}
              </p>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() =>
                  void api("/v1/account/delete", {
                    method: "POST",
                    body: JSON.stringify({ password: deletePassword }),
                  })
                    .then(() => router.push("/"))
                    .catch((err) => setError((err as Error).message))
                }
                className="rounded bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700"
              >
                Permanently delete everything
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="rounded border border-zinc-300 px-4 py-2 text-sm dark:border-zinc-600"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="mt-3 rounded border border-red-300 px-4 py-2 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950"
          >
            Delete my account…
          </button>
        )}
      </section>

      <p className="mt-8 text-sm">
        <Link href="/dashboard" className="underline">
          ← Back to dashboard
        </Link>
      </p>
    </main>
  );
}
