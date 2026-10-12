"use client";

import { useState, useSyncExternalStore } from "react";

/** Where to go after signing in: the page that was asked for, if it is one of ours. */
function destination(): string {
  const next = new URLSearchParams(window.location.search).get("next") ?? "/";
  return next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

// What the server says when the form was sent without this page's script (see /api/login).
const FROM_SERVER: Record<string, string> = {
  wrong: "That email and password do not match.",
  locked: "Too many wrong tries. Wait a few minutes and try again.",
  setup: "Sign-in is not set up yet. Add LOGIN_EMAIL and LOGIN_PASSWORD to .env.local and restart.",
};
const never = () => () => {};

export default function LoginPage() {
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const query = useSyncExternalStore(never, () => window.location.search, () => "");
  const shown = error ?? FROM_SERVER[new URLSearchParams(query).get("error") ?? ""] ?? null;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // Read from the form itself, so anything typed before this script loaded is kept.
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: String(form.get("email") ?? ""), password: String(form.get("password") ?? "") }),
      });
      if (res.ok) return window.location.assign(destination());
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Could not sign in. Try again.");
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    }
    setBusy(false);
  }

  return (
    <main className="login-wrap">
      {/* method and action are the fallback: the password must never end up in the address bar. */}
      <form className="panel login" method="post" action="/api/login" onSubmit={submit}>
        <div>
          <h1>Command Center</h1>
          <p className="muted">Sign in to see your messages, calls and tasks.</p>
        </div>
        <label className="login-field">
          <span>Email</span>
          <input className="f" type="email" name="email" autoComplete="username" placeholder="you@company.com" required autoFocus />
        </label>
        <label className="login-field">
          <span>Password</span>
          <span className="login-pass">
            <input className="f" type={show ? "text" : "password"} name="password" autoComplete="current-password" required />
            <button type="button" className="linkbtn" aria-pressed={show} onClick={() => setShow(!show)}>
              {show ? "Hide" : "Show"}
            </button>
          </span>
        </label>
        {shown && (
          <p className="login-error" role="alert">
            {shown}
          </p>
        )}
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="login-note">You stay signed in on this device for 7 days.</p>
      </form>
    </main>
  );
}
