"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "../../lib/api";

function ResetPasswordInner() {
  const params = useSearchParams();
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6">
      <h1 className="text-2xl font-bold">Choose a new password</h1>
      <form
        className="mt-6 space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void api("/v1/auth/reset-password", {
            method: "POST",
            body: JSON.stringify({
              token: params.get("token") ?? "",
              password,
            }),
          })
            .then(() => router.push("/signin"))
            .catch((err) => setError((err as Error).message));
        }}
      >
        <input
          type="password"
          required
          minLength={10}
          placeholder="New password (10+ characters)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded border border-zinc-300 px-3 py-2 dark:border-zinc-600 dark:bg-zinc-800"
          aria-label="New password"
        />
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
        <button
          type="submit"
          className="w-full rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
        >
          Set new password
        </button>
      </form>
    </main>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<main className="p-10 text-zinc-500">Loading…</main>}>
      <ResetPasswordInner />
    </Suspense>
  );
}
