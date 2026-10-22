"use client";

import { useState } from "react";
import { PROVIDER_NAME } from "@/core/providers";
import type { Provider } from "@/core/types";
import { connectProvider } from "@/store/store";

/** A field for a key or token. It is sent to the server once and never kept in the browser. */
export function SecretField({ provider, label, placeholder, check }: { provider: Provider; label: string; placeholder: string; check(value: string): string | null }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = `${provider}-secret`;
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const problem = check(value);
        setError(problem);
        if (problem) return;
        setBusy(true);
        // The service itself has the last word on whether the key is good.
        const refused = await connectProvider(provider, value);
        setBusy(false);
        setError(refused);
        if (!refused) setValue("");
      }}
    >
      <div className="key-row">
        <input
          className="f"
          id={id}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          placeholder={placeholder}
          aria-label={label}
          aria-invalid={error != null}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
        />
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? "Checking…" : `Connect ${PROVIDER_NAME[provider]}`}
        </button>
      </div>
      {error && (
        <div className="field-error" id={`${id}-error`} role="alert">
          {error}
        </div>
      )}
    </form>
  );
}

