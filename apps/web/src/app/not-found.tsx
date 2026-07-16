import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6 text-center">
      <h1 className="text-3xl font-bold">Page not found</h1>
      <p className="mt-2 text-zinc-500">
        If you followed a share link, it may have expired or been revoked by the
        creator.
      </p>
      <Link href="/" className="mt-6 underline">
        Go to the home page
      </Link>
    </main>
  );
}
