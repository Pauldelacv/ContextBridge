"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FormEvent } from "react";

interface FieldSpec {
  name: string;
  label: string;
  type?: string;
  autoComplete?: string;
  placeholder?: string;
}

/** Shared login/signup form. Errors come from the API's error envelope. */
export function AuthForm({
  endpoint,
  fields,
  submitLabel,
}: {
  endpoint: string;
  fields: FieldSpec[];
  submitLabel: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);

    const payload = Object.fromEntries(new FormData(event.currentTarget).entries());

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(body?.error?.message ?? "Something went wrong. Please try again.");
        setPending(false);
        return;
      }

      router.replace("/ask");
      router.refresh();
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
      setPending(false);
    }
  }

  return (
    <form className="stack" onSubmit={onSubmit} noValidate>
      {error ? (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      ) : null}

      {fields.map((field) => (
        <div className="field" key={field.name}>
          <label className="label" htmlFor={field.name}>
            {field.label}
          </label>
          <input
            className="input"
            id={field.name}
            name={field.name}
            type={field.type ?? "text"}
            autoComplete={field.autoComplete}
            placeholder={field.placeholder}
            required
          />
        </div>
      ))}

      <button className="button" type="submit" disabled={pending}>
        {pending ? <span className="spinner" aria-hidden="true" /> : null}
        {pending ? "Working..." : submitLabel}
      </button>
    </form>
  );
}
