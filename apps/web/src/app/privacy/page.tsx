export const metadata = { title: "Privacy" };

export default function PrivacyPage() {
  return (
    <main className="prose prose-zinc mx-auto max-w-2xl px-6 py-12 dark:prose-invert">
      <h1 className="text-3xl font-bold">Privacy</h1>
      <div className="mt-6 space-y-4 text-zinc-700 dark:text-zinc-300">
        <h2 className="text-xl font-semibold">Creator audio</h2>
        <p>
          Your microphone audio is streamed to our transcription pipeline while
          you are live. It is stored only when you enable recording for a
          session, and it is deleted automatically when the session&apos;s
          retention period ends — or immediately when you delete it.
        </p>
        <h2 className="text-xl font-semibold">Viewer audio</h2>
        <p>
          When a viewer uses Read Aloud Mode, their speech is recognized inside
          their own browser. Viewer audio is{" "}
          <strong>never uploaded and never stored</strong>. Only the derived
          reading position (word and sentence index) is sent to keep the session
          analytics meaningful.
        </p>
        <h2 className="text-xl font-semibold">Third-party speech providers</h2>
        <p>
          When a real streaming transcription provider is configured, creator
          audio is processed by that provider under its data-processing terms.
          The provider in use is shown in the session preflight. Deployments
          without provider credentials use the built-in offline pipeline only.
        </p>
        <h2 className="text-xl font-semibold">Share links and access logs</h2>
        <p>
          Share links use unguessable random identifiers and are excluded from
          search-engine indexing. Access events store a salted hash of the IP
          address and the browser family — never the raw address.
        </p>
        <h2 className="text-xl font-semibold">Your controls</h2>
        <ul className="list-disc pl-5">
          <li>Export all of your data from the Account page.</li>
          <li>
            Delete recordings, transcripts, sessions, or your entire account.
          </li>
          <li>
            Revoke a share link at any time; existing viewers lose access.
          </li>
          <li>Configure per-session retention from 7 days to 1 year.</li>
        </ul>
        <p className="text-sm text-zinc-500">
          Full technical details: see PRIVACY_ARCHITECTURE.md in the project
          documentation.
        </p>
      </div>
    </main>
  );
}
