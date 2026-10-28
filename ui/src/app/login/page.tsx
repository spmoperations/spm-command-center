"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

/** Where to go after signing in: the page that was asked for, if it is one of ours. */
function destination(): string {
  const next = new URLSearchParams(window.location.search).get("next") ?? "/";
  if (!next.startsWith("/")) return "/";
  // "//elsewhere", or the same with a tab or a backslash in it, would be another site.
  const to = new URL(next, window.location.origin);
  return to.origin === window.location.origin ? `${to.pathname}${to.search}` : "/";
}

// What the server says when the form was sent without this page's script (see /api/login).
const FROM_SERVER: Record<string, string> = {
  wrong: "That email and password do not match.",
  locked: "Too many wrong tries. Wait a few minutes and try again.",
  setup: "Sign-in is not set up yet. Add LOGIN_EMAIL and LOGIN_PASSWORD to .env.local and restart.",
  // From Sign in with Google (server/google-sign-in.ts).
  "google-none": "That Google account has no login here. Ask for it to be added, or sign in with your email and password.",
  "google-off": "Sign in with Google is not set up here. Use your email and password.",
  "google-again": "That Google sign-in timed out or did not start here. Try again.",
  "google-denied": "Google was not allowed in, so you were not signed in.",
  "google-failed": "Google could not sign you in. Try again, or use your email and password.",
};
const never = () => () => {};

/** Google's "G", in its four colors, as Google asks its sign-in buttons to show it. */
const GoogleMark = () => (
  <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.5 0 6.7 1.2 9.2 3.6l6.9-6.9C35.9 2.4 30.4 0 24 0 14.6 0 6.6 5.4 2.7 13.3l8 6.2C12.6 13.6 17.8 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 7l7.2 5.6c4.2-3.9 7.1-9.6 7.1-17.1z" />
    <path fill="#FBBC05" d="M10.7 28.5c-.5-1.4-.8-2.9-.8-4.5s.3-3.1.8-4.5l-8-6.2C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l8-6.2z" />
    <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.2-5.6c-2.2 1.5-5 2.4-8.7 2.4-6.2 0-11.4-4.1-13.3-9.8l-8 6.2C6.6 42.6 14.6 48 24 48z" />
  </svg>
);

export default function LoginPage() {
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const query = useSyncExternalStore(never, () => window.location.search, () => "");
  const shown = error ?? FROM_SERVER[new URLSearchParams(query).get("error") ?? ""] ?? null;
  // Offered only where the server has it set up.
  const [google, setGoogle] = useState(false);
  useEffect(() => {
    fetch("/api/login", { cache: "no-store" })
      .then((res) => res.json())
      .then((data: { google?: boolean }) => setGoogle(data.google === true))
      .catch(() => {});
  }, []);

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
        {google && (
          <>
            <div className="login-or" aria-hidden="true">
              or
            </div>
            {/* A plain link: Google's page can only send the person back with one. */}
            <a className="btn login-google" href={`/api/login/google?next=${encodeURIComponent(destination())}`}>
              <GoogleMark />
              Sign in with Google
            </a>
          </>
        )}
        <p className="login-note">You stay signed in on this device for 7 days.</p>
      </form>
    </main>
  );
}
