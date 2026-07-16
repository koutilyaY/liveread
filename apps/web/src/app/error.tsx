"use client";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6 text-center">
      <h1 className="text-3xl font-bold">Something went wrong</h1>
      <p className="mt-2 text-zinc-500">
        Your work on the server is safe. Try again — if it keeps happening,
        report the code below.
      </p>
      {error.digest && (
        <p className="mt-2 font-mono text-xs text-zinc-400">
          ref: {error.digest}
        </p>
      )}
      <button
        type="button"
        onClick={reset}
        className="mt-6 rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
      >
        Try again
      </button>
    </main>
  );
}
