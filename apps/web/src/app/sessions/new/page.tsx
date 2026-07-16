"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiRequestError } from "../../../lib/api";

const LANGUAGES = [
  ["en-US", "English (US)"],
  ["en-GB", "English (UK)"],
  ["es-ES", "Español"],
  ["hi-IN", "हिन्दी"],
  ["ar-SA", "العربية"],
  ["zh-CN", "中文 (简体)"],
] as const;

export default function NewSessionPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    title: "",
    languageCode: "en-US",
    privacyMode: "unlisted",
    passcode: "",
    creatorAudioEnabled: false,
    recordingEnabled: true,
    retentionDays: 90,
    vocabularyText: "",
  });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const vocabulary = form.vocabularyText
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 100)
        .map((phrase) => ({ phrase, boost: 1 }));
      const session = await api<{ id: string; viewerUrl: string }>(
        "/v1/sessions",
        {
          method: "POST",
          body: JSON.stringify({
            title: form.title,
            languageCode: form.languageCode,
            privacyMode: form.privacyMode,
            ...(form.privacyMode === "passcode" && form.passcode
              ? { passcode: form.passcode }
              : {}),
            creatorAudioEnabled: form.creatorAudioEnabled,
            recordingEnabled: form.recordingEnabled,
            retentionDays: form.retentionDays,
            vocabulary,
          }),
        },
      );
      // the share token is returned exactly once; hand it to the studio
      sessionStorage.setItem(`viewerUrl:${session.id}`, session.viewerUrl);
      router.push(`/studio/${session.id}`);
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.status === 403
            ? "Verify your email address before starting a live session."
            : err.message
          : "Something went wrong.",
      );
      setSubmitting(false);
    }
  };

  const input =
    "w-full rounded border border-zinc-300 bg-white px-3 py-2 dark:border-zinc-600 dark:bg-zinc-800";

  return (
    <main className="mx-auto max-w-xl px-6 py-10">
      <h1 className="text-2xl font-bold">New Live Session</h1>
      <form onSubmit={submit} className="mt-6 space-y-5">
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Title</span>
          <input
            required
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            className={input}
            data-testid="session-title-input"
            maxLength={200}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">
            Spoken language
          </span>
          <select
            value={form.languageCode}
            onChange={(e) => setForm({ ...form, languageCode: e.target.value })}
            className={input}
          >
            {LANGUAGES.map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend className="mb-1 text-sm font-medium">Privacy</legend>
          <select
            value={form.privacyMode}
            onChange={(e) => setForm({ ...form, privacyMode: e.target.value })}
            className={input}
            aria-label="Privacy mode"
          >
            <option value="unlisted">Unlisted — anyone with the link</option>
            <option value="passcode">Passcode — link plus a passcode</option>
            <option value="private">Private — only you</option>
          </select>
          {form.privacyMode === "passcode" && (
            <input
              placeholder="Passcode (min 4 characters)"
              value={form.passcode}
              onChange={(e) => setForm({ ...form, passcode: e.target.value })}
              className={`${input} mt-2`}
              minLength={4}
            />
          )}
        </fieldset>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.recordingEnabled}
            onChange={(e) =>
              setForm({ ...form, recordingEnabled: e.target.checked })
            }
          />
          Record my audio (viewers can play it back after the session)
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">
            Keep recording and transcript for
          </span>
          <select
            value={form.retentionDays}
            onChange={(e) =>
              setForm({ ...form, retentionDays: Number(e.target.value) })
            }
            className={input}
          >
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
            <option value={365}>1 year</option>
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">
            Vocabulary hints (optional, one per line)
          </span>
          <textarea
            rows={3}
            value={form.vocabularyText}
            onChange={(e) =>
              setForm({ ...form, vocabularyText: e.target.value })
            }
            className={input}
            placeholder={"Ljubljana\nNakamura"}
          />
        </label>
        {error && (
          <p
            role="alert"
            className="text-sm text-red-600"
            data-testid="create-error"
          >
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-50"
          data-testid="create-session"
        >
          {submitting ? "Creating…" : "Continue to preflight"}
        </button>
      </form>
    </main>
  );
}
