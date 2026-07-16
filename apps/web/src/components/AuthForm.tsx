"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, ApiRequestError } from "../lib/api";

const SignupSchema = z.object({
  displayName: z.string().min(1, "Tell us what to call you."),
  email: z.string().email("Enter a valid email address."),
  password: z.string().min(10, "Use at least 10 characters."),
});

const SigninSchema = z.object({
  email: z.string().email("Enter a valid email address."),
  password: z.string().min(1, "Enter your password."),
});

export function AuthForm({ mode }: { mode: "signup" | "signin" }) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const schema = mode === "signup" ? SignupSchema : SigninSchema;
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<z.infer<typeof SignupSchema>>({
    resolver: zodResolver(schema as typeof SignupSchema),
  });

  const onSubmit = handleSubmit(async (values) => {
    setServerError(null);
    try {
      await api(`/v1/auth/${mode === "signup" ? "signup" : "login"}`, {
        method: "POST",
        body: JSON.stringify(values),
      });
      router.push("/dashboard");
    } catch (err) {
      setServerError(
        err instanceof ApiRequestError ? err.message : "Something went wrong.",
      );
    }
  });

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6">
      <h1 className="text-2xl font-bold">
        {mode === "signup" ? "Create your account" : "Welcome back"}
      </h1>
      <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
        {mode === "signup" && (
          <Field label="Display name" error={errors.displayName?.message}>
            <input
              {...register("displayName")}
              className="w-full rounded border border-zinc-300 bg-white px-3 py-2 dark:border-zinc-600 dark:bg-zinc-800 dark:text-white"
              autoComplete="name"
              data-testid="displayName"
            />
          </Field>
        )}
        <Field label="Email" error={errors.email?.message}>
          <input
            {...register("email")}
            type="email"
            className="w-full rounded border border-zinc-300 bg-white px-3 py-2 dark:border-zinc-600 dark:bg-zinc-800 dark:text-white"
            autoComplete="email"
            data-testid="email"
          />
        </Field>
        <Field label="Password" error={errors.password?.message}>
          <input
            {...register("password")}
            type="password"
            className="w-full rounded border border-zinc-300 bg-white px-3 py-2 dark:border-zinc-600 dark:bg-zinc-800 dark:text-white"
            autoComplete={
              mode === "signup" ? "new-password" : "current-password"
            }
            data-testid="password"
          />
        </Field>
        {serverError && (
          <p
            role="alert"
            className="text-sm text-red-600"
            data-testid="auth-error"
          >
            {serverError}
          </p>
        )}
        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-50"
          data-testid="auth-submit"
        >
          {isSubmitting
            ? "One moment…"
            : mode === "signup"
              ? "Create account"
              : "Sign in"}
        </button>
      </form>
      <p className="mt-4 text-sm text-zinc-500">
        {mode === "signup" ? (
          <>
            Already have an account?{" "}
            <Link className="underline" href="/signin">
              Sign in
            </Link>
          </>
        ) : (
          <>
            New here?{" "}
            <Link className="underline" href="/signup">
              Create an account
            </Link>
            {" · "}
            <Link className="underline" href="/reset-password/request">
              Forgot password?
            </Link>
          </>
        )}
      </p>
    </main>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      {children}
      {error && (
        <span role="alert" className="mt-1 block text-xs text-red-600">
          {error}
        </span>
      )}
    </label>
  );
}
