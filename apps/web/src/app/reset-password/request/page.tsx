"use client";

import { useState } from "react";
import Link from "next/link";
import { api } from "../../../lib/api";

export default function RequestResetPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6">
      <h1 className="text-2xl font-bold">Reset your password</h1>
      {sent ? (
        <p className="mt-4 text-zinc-600 dark:text-zinc-300">
          If an account exists for that address, a reset link is on its way.
        </p>
      ) : (
        <form
          className="mt-6 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void api("/v1/auth/request-password-reset", {
              method: "POST",
              body: JSON.stringify({ email }),
            }).finally(() => setSent(true));
          }}
        >
          <input
            type="email"
            required
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded border border-zinc-300 px-3 py-2 dark:border-zinc-600 dark:bg-zinc-800"
            aria-label="Email address"
          />
          <button
            type="submit"
            className="w-full rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
          >
            Send reset link
          </button>
        </form>
      )}
      <p className="mt-4 text-sm">
        <Link href="/signin" className="underline">
          Back to sign in
        </Link>
      </p>
    </main>
  );
}
