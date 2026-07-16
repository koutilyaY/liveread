export const metadata = { title: "Accessibility" };

export default function AccessibilityPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="text-3xl font-bold">Accessibility statement</h1>
      <div className="mt-6 space-y-4 text-zinc-700 dark:text-zinc-300">
        <p>
          LiveRead aims to meet WCAG 2.2 AA. Reading is a core accessibility use
          case for us, and the reading experience is designed to work without a
          microphone:
        </p>
        <ul className="list-disc space-y-2 pl-5">
          <li>Full keyboard navigation with visible focus indicators.</li>
          <li>
            Manual reading cursor: tap or use Enter on any sentence to move the
            cursor — voice is never required.
          </li>
          <li>Adjustable font size, line spacing, and a high-contrast mode.</li>
          <li>
            <code>prefers-reduced-motion</code> disables smooth scrolling and
            animations.
          </li>
          <li>
            Status changes (caught up, degraded transcription) are announced
            through a polite live region that avoids flooding screen readers
            with every interim token.
          </li>
          <li>No information is conveyed by color alone.</li>
        </ul>
        <p>
          Found a barrier? Use the report link on any session page — an
          accessibility report is triaged like an incident.
        </p>
      </div>
    </main>
  );
}
