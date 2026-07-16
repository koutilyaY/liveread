"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "../../lib/api";

function ReportInner() {
  const params = useSearchParams();
  const shareId = params.get("s");
  const [reason, setReason] = useState("abuse");
  const [details, setDetails] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!shareId) {
    return <p className="text-red-600">Missing session reference.</p>;
  }
  if (sent) {
    return (
      <p className="text-zinc-600 dark:text-zinc-300">
        Thank you. The report was filed and will be reviewed.
      </p>
    );
  }
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void api(`/v1/share/${shareId}/report`, {
          method: "POST",
          body: JSON.stringify({ reason, details }),
        })
          .then(() => setSent(true))
          .catch((err) => setError((err as Error).message));
      }}
    >
      <h1 className="text-2xl font-bold">Report this session</h1>
      <select
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        className="w-full rounded border border-zinc-300 px-3 py-2 dark:border-zinc-600 dark:bg-zinc-800"
        aria-label="Reason"
      >
        <option value="abuse">Abusive or harmful content</option>
        <option value="illegal">Illegal content</option>
        <option value="spam">Spam</option>
        <option value="other">Something else</option>
      </select>
      <textarea
        rows={4}
        value={details}
        onChange={(e) => setDetails(e.target.value)}
        placeholder="Details (optional)"
        className="w-full rounded border border-zinc-300 px-3 py-2 dark:border-zinc-600 dark:bg-zinc-800"
        aria-label="Details"
      />
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      <button
        type="submit"
        className="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
      >
        Submit report
      </button>
    </form>
  );
}

export default function ReportPage() {
  return (
    <main className="mx-auto max-w-lg px-6 py-12">
      <Suspense fallback={<p className="text-zinc-500">Loading…</p>}>
        <ReportInner />
      </Suspense>
    </main>
  );
}
