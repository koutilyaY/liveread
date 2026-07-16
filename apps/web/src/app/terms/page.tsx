export const metadata = { title: "Terms" };

export default function TermsPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="text-3xl font-bold">Terms of Service</h1>
      <p className="mt-4 rounded bg-amber-50 p-4 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
        <strong>
          Placeholder — requires qualified legal review before public launch.
        </strong>{" "}
        This draft outlines intent only and is not legal advice or a binding
        agreement.
      </p>
      <div className="mt-6 space-y-4 text-zinc-700 dark:text-zinc-300">
        <p>Draft intent, pending counsel review:</p>
        <ul className="list-disc space-y-2 pl-5">
          <li>You must have the right to broadcast the content you speak.</li>
          <li>
            Abusive, illegal, or infringing content may be removed and accounts
            suspended; viewers can report abuse from any session page.
          </li>
          <li>
            Automated transcription is provided best-effort and can contain
            errors; it is not suitable as a sole record for legal or medical
            purposes.
          </li>
          <li>
            Minimum-age and guardian-consent requirements must be configured per
            deployment jurisdiction before public launch.
          </li>
        </ul>
      </div>
    </main>
  );
}
