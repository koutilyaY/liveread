"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { api } from "../../lib/api";

function VerifyEmailInner() {
  const params = useSearchParams();
  const [state, setState] = useState<"working" | "done" | "failed">("working");

  useEffect(() => {
    const token = params.get("token");
    if (!token) {
      setState("failed");
      return;
    }
    api("/v1/auth/verify-email", {
      method: "POST",
      body: JSON.stringify({ token }),
    })
      .then(() => setState("done"))
      .catch(() => setState("failed"));
  }, [params]);

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6 text-center">
      {state === "working" && (
        <p className="text-zinc-500">Verifying your email…</p>
      )}
      {state === "done" && (
        <>
          <h1 className="text-2xl font-bold">Email verified ✓</h1>
          <Link href="/dashboard" className="mt-4 underline">
            Go to your dashboard
          </Link>
        </>
      )}
      {state === "failed" && (
        <>
          <h1 className="text-2xl font-bold">Verification failed</h1>
          <p className="mt-2 text-zinc-500">
            This link is invalid or expired. Sign in and request a new one.
          </p>
          <Link href="/signin" className="mt-4 underline">
            Sign in
          </Link>
        </>
      )}
    </main>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<main className="p-10 text-zinc-500">Loading…</main>}>
      <VerifyEmailInner />
    </Suspense>
  );
}
