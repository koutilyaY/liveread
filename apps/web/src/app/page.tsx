import Link from "next/link";

export default function LandingPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-20">
      <h1 className="text-4xl font-bold tracking-tight">LiveRead</h1>
      <p className="mt-4 text-lg text-zinc-600 dark:text-zinc-300">
        Speak live and your words are published as text, worldwide, in near real
        time. Every reader can press <strong>Read Aloud</strong> and the page
        follows <em>their</em> voice — at their own pace, independent of yours.
      </p>
      <div className="mt-8 flex gap-3">
        <Link
          href="/signup"
          className="rounded bg-blue-600 px-5 py-2.5 text-white hover:bg-blue-700"
        >
          Start speaking
        </Link>
        <Link
          href="/signin"
          className="rounded border border-zinc-300 px-5 py-2.5 hover:bg-zinc-100 dark:border-zinc-600 dark:hover:bg-zinc-800"
        >
          Sign in
        </Link>
      </div>
      <section className="mt-16 grid gap-6 sm:grid-cols-3">
        {[
          {
            title: "Near-real-time text",
            body: "Interim words appear while you speak and stabilize into a final, editable transcript.",
          },
          {
            title: "Voice-following reading",
            body: "Readers grant their mic, read out loud, and the highlight and scroll follow them. Their audio never leaves the browser.",
          },
          {
            title: "Yours to control",
            body: "Private-by-default share links you can expire or revoke, opt-in recording, and configurable retention.",
          },
        ].map((f) => (
          <div
            key={f.title}
            className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-700 dark:bg-zinc-900"
          >
            <h2 className="font-semibold">{f.title}</h2>
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
              {f.body}
            </p>
          </div>
        ))}
      </section>
      <footer className="mt-16 flex gap-4 text-sm text-zinc-500">
        <Link href="/privacy" className="underline">
          Privacy
        </Link>
        <Link href="/terms" className="underline">
          Terms
        </Link>
        <Link href="/accessibility" className="underline">
          Accessibility
        </Link>
        <Link href="/status" className="underline">
          Status
        </Link>
      </footer>
    </main>
  );
}
