"use client";

import Link from "next/link";
import { useState } from "react";
import { toast, useApp } from "@/store/store";

// The guide for setting Google up, for the person whose Google account it is. Step 1 happens
// in Google Cloud, once, and ends with two keys sent to Shruti in #spm-development. She adds
// them to the live site, and Step 2, connecting the account, appears here by itself.

const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/calendar.events"];

/** One part of a screen sketch. `hi` outlines it as the thing to fill in or click. */
type Part =
  | { t: "title"; text: string }
  | { t: "text"; text: string }
  | { t: "field"; label: string; value: string; hi?: boolean }
  | { t: "radio"; options: string[]; picked: number; hi?: boolean }
  | { t: "check"; label: string; hi?: boolean }
  | { t: "code"; lines: string[]; hi?: boolean }
  | { t: "buttons"; items: { label: string; primary?: boolean; hi?: boolean }[] };

/** A simple drawing of a Google Cloud screen, with what to do on it outlined. */
function Sketch({ url, parts, caption }: { url: string; parts: Part[]; caption: string }) {
  return (
    <figure className="sk">
      <div className="sk-frame" role="img" aria-label={caption}>
        <div className="sk-bar">
          <span className="sk-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="sk-url">{url}</span>
        </div>
        <div className="sk-body">
          {parts.map((p, k) => {
            if (p.t === "title") return <div key={k} className="sk-title">{p.text}</div>;
            if (p.t === "text") return <div key={k} className="sk-text">{p.text}</div>;
            if (p.t === "field")
              return (
                <div key={k} className={`sk-field ${p.hi ? "hi" : ""}`}>
                  <span>{p.label}</span>
                  <b>{p.value}</b>
                </div>
              );
            if (p.t === "radio")
              return (
                <div key={k} className={`sk-radio ${p.hi ? "hi" : ""}`}>
                  {p.options.map((o, n) => (
                    <span key={o} className={n === p.picked ? "on" : ""}>
                      <i aria-hidden="true" />
                      {o}
                    </span>
                  ))}
                </div>
              );
            if (p.t === "check")
              return (
                <div key={k} className={`sk-check ${p.hi ? "hi" : ""}`}>
                  <i aria-hidden="true">✓</i>
                  {p.label}
                </div>
              );
            if (p.t === "code")
              return (
                <pre key={k} className={`sk-code ${p.hi ? "hi" : ""}`}>
                  {p.lines.join("\n")}
                </pre>
              );
            return (
              <div key={k} className="sk-buttons">
                {p.items.map((b) => (
                  <span key={b.label} className={`sk-btn ${b.primary ? "primary" : ""} ${b.hi ? "hi" : ""}`}>
                    {b.label}
                  </span>
                ))}
              </div>
            );
          })}
        </div>
      </div>
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  return (
    <button
      className="btn"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => toast("Copied"),
          () => toast("Select it and copy it by hand"),
        );
      }}
    >
      {label}
    </button>
  );
}

const Open = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <a className="btn primary extlink" href={href} target="_blank" rel="noopener noreferrer">
    {children} ↗
  </a>
);

/** One numbered part of Step 1. */
function Part({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <li className="gs-part">
      <div className="gs-n" aria-hidden="true">
        {n}
      </div>
      <div className="gs-body">
        <h4>{title}</h4>
        {children}
      </div>
    </li>
  );
}

/** The message for #spm-development, made from the two keys. Nothing is kept or sent from here. */
function KeysMessage() {
  const [id, setId] = useState("");
  const [secret, setSecret] = useState("");
  const message = `Google keys for the Command Center:\nClient ID: ${id.trim() || "…"}\nClient secret: ${secret.trim() || "…"}`;
  return (
    <div className="gs-keys">
      <label>
        Client ID
        <input className="f" value={id} onChange={(e) => setId(e.target.value)} placeholder="…apps.googleusercontent.com" spellCheck={false} />
      </label>
      <label>
        Client secret
        <input className="f" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="GOCSPX-…" spellCheck={false} />
      </label>
      <pre className="gs-message">{message}</pre>
      <div>
        <Copy text={message} label="Copy the message" />
      </div>
      <p className="st-help">Nothing you type here is saved or sent by the dashboard. It only makes the message for you to paste in Slack.</p>
    </div>
  );
}

export default function GoogleSetupPage() {
  const app = useApp();
  if (!app) return null;
  const { state } = app;
  const keysIn = state.googleAvailable;
  const callback = `${window.location.origin}/api/google/callback`;
  const accounts = state.googleAccounts;

  return (
    <section className="view gs">
      <div className="view-head">
        <div>
          <Link href="/connections#google" className="srclink">
            ← Connections
          </Link>
          <h2>Setting up Google</h2>
          <div className="muted" style={{ fontSize: 14, maxWidth: "70ch" }}>
            So your emails and calendar show in the Command Center, and you can answer emails and add events from here. It takes two steps: <strong>Step 1</strong> in Google Cloud, once, about 10 minutes. Then <strong>Step 2</strong>, connecting your account, one click.
          </div>
        </div>
      </div>

      <ol className="gs-steps">
        <li className={`panel gs-step ${keysIn ? "done" : "now"}`}>
          <div className="gs-step-head">
            <span className="gs-badge">{keysIn ? "Done" : "Step 1"}</span>
            <h3>Set up Google Cloud, and send Shruti the two keys</h3>
          </div>
          {keysIn ? (
            <p className="st-help">The keys are in place on this site. Go on to Step 2.</p>
          ) : (
            <>
              <p className="st-help">
                Do this on a computer, signed in to Google with your <strong>SPM Google account</strong>: the one your socialprofitmedia.co email uses. Each button opens the right page. At the top left of every page, check the project name says <strong>SPM Command Center</strong>.
              </p>
              <ol className="gs-parts">
                <Part n="1" title="Make a project">
                  <p>Open the page, type the name, and click Create. Google takes a few seconds, then shows the new project.</p>
                  <Open href="https://console.cloud.google.com/projectcreate">Open New project</Open>
                  <Sketch
                    url="console.cloud.google.com/projectcreate"
                    caption="Project name: SPM Command Center. Leave the rest as it is, then click Create."
                    parts={[{ t: "title", text: "New Project" }, { t: "field", label: "Project name", value: "SPM Command Center", hi: true }, { t: "field", label: "Organization", value: "socialprofitmedia.co" }, { t: "buttons", items: [{ label: "Create", primary: true, hi: true }, { label: "Cancel" }] }]}
                  />
                </Part>
                <Part n="2" title="Turn on Gmail and Calendar">
                  <p>Open each page and click Enable. Do both.</p>
                  <div className="gs-row">
                    <Open href="https://console.cloud.google.com/apis/library/gmail.googleapis.com">Open Gmail API</Open>
                    <Open href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com">Open Google Calendar API</Open>
                  </div>
                  <Sketch
                    url="console.cloud.google.com/apis/library/gmail.googleapis.com"
                    caption="Click Enable. Then the same on the Google Calendar API page."
                    parts={[{ t: "title", text: "Gmail API" }, { t: "text", text: "Google Enterprise API · View and manage Gmail data" }, { t: "buttons", items: [{ label: "Enable", primary: true, hi: true }, { label: "Try this API" }] }]}
                  />
                </Part>
                <Part n="3" title="Set up the sign-in screen">
                  <p>
                    Open the page and click <strong>Get started</strong>. It has four parts:
                  </p>
                  <ol className="gs-list">
                    <li>
                      <strong>App Information:</strong> App name <code>SPM Command Center</code>. User support email: pick your email. Click Next.
                    </li>
                    <li>
                      <strong>Audience:</strong> pick <strong>Internal</strong>. Click Next. (Internal means only SPM&apos;s own Google accounts can use it, and nobody sees a warning.)
                    </li>
                    <li>
                      <strong>Contact Information:</strong> your email. Click Next.
                    </li>
                    <li>
                      <strong>Finish:</strong> tick &quot;I agree to the Google API Services: User Data Policy&quot;, click Continue, then <strong>Create</strong>.
                    </li>
                  </ol>
                  <Open href="https://console.cloud.google.com/auth/overview">Open the sign-in screen setup</Open>
                  <Sketch
                    url="console.cloud.google.com/auth/overview/create"
                    caption="App name and support email, Internal, your email again, tick the box, Create."
                    parts={[
                      { t: "title", text: "Project configuration" },
                      { t: "field", label: "1  App name", value: "SPM Command Center", hi: true },
                      { t: "field", label: "User support email", value: "you@socialprofitmedia.co", hi: true },
                      { t: "radio", options: ["Internal", "External"], picked: 0, hi: true },
                      { t: "field", label: "3  Contact email", value: "you@socialprofitmedia.co" },
                      { t: "check", label: "I agree to the Google API Services: User Data Policy", hi: true },
                      { t: "buttons", items: [{ label: "Create", primary: true, hi: true }, { label: "Cancel" }] },
                    ]}
                  />
                  <p className="st-help">If Internal can&apos;t be picked, the account isn&apos;t part of SPM&apos;s Google Workspace. Ask Shruti before going on.</p>
                </Part>
                <Part n="4" title="Say what it may do">
                  <p>
                    Open the page, click <strong>Add or remove scopes</strong>. At the bottom, under <strong>Manually add scopes</strong>, paste these three lines, then click <strong>Add to table</strong>, <strong>Update</strong> and <strong>Save</strong>.
                  </p>
                  <div className="gs-copy">
                    <pre>{SCOPES.join("\n")}</pre>
                    <Copy text={SCOPES.join("\n")} label="Copy the three lines" />
                  </div>
                  <p className="st-help">They let it read your Gmail, send email you write here, and read and add calendar events. It can&apos;t delete anything.</p>
                  <Open href="https://console.cloud.google.com/auth/scopes">Open Data access</Open>
                  <Sketch
                    url="console.cloud.google.com/auth/scopes"
                    caption="Paste the three lines under Manually add scopes, then Add to table, Update, and Save on the page."
                    parts={[{ t: "title", text: "Update selected scopes" }, { t: "text", text: "Manually add scopes" }, { t: "code", lines: SCOPES, hi: true }, { t: "buttons", items: [{ label: "Add to table", hi: true }, { label: "Update", primary: true, hi: true }] }]}
                  />
                </Part>
                <Part n="5" title="Make the client, with the return address">
                  <p>
                    Open the page. For <strong>Application type</strong> pick <strong>Web application</strong>; more boxes appear. Name it <code>Command Center</code>. Leave Authorized JavaScript origins empty. Under <strong>Authorized redirect URIs</strong>, click <strong>+ Add URI</strong> and paste this address, exactly. Then click <strong>Create</strong>.
                  </p>
                  <div className="gs-copy">
                    <pre>{callback}</pre>
                    <Copy text={callback} label="Copy the address" />
                  </div>
                  <Open href="https://console.cloud.google.com/auth/clients/create">Open Create client</Open>
                  <Sketch
                    url="console.cloud.google.com/auth/clients/create"
                    caption="Web application, a name, the address under Authorized redirect URIs, then Create."
                    parts={[
                      { t: "title", text: "Create OAuth client ID" },
                      { t: "field", label: "Application type", value: "Web application", hi: true },
                      { t: "field", label: "Name", value: "Command Center" },
                      { t: "text", text: "Authorized redirect URIs" },
                      { t: "field", label: "URIs 1", value: callback, hi: true },
                      { t: "buttons", items: [{ label: "+ Add URI" }, { label: "Create", primary: true, hi: true }] },
                    ]}
                  />
                </Part>
                <Part n="6" title="Copy the two keys">
                  <p>
                    A box opens with the <strong>Client ID</strong> and the <strong>Client secret</strong>. Copy both now: Google may not show the secret in full again. The secret is like a password.
                  </p>
                  <Sketch
                    url="console.cloud.google.com/auth/clients"
                    caption="Copy the Client ID and the Client secret, with the copy buttons beside them."
                    parts={[
                      { t: "title", text: "OAuth client created" },
                      { t: "field", label: "Client ID", value: "1234-abcd….apps.googleusercontent.com  ⧉", hi: true },
                      { t: "field", label: "Client secret", value: "GOCSPX-…  ⧉", hi: true },
                      { t: "buttons", items: [{ label: "OK", primary: true }] },
                    ]}
                  />
                </Part>
                <Part n="7" title="Send them to Shruti in #spm-development">
                  <p>
                    Paste them below to make the message, then post it in Slack in <strong>#spm-development</strong> (a private channel). That&apos;s the end of Step 1. Shruti adds them to the Command Center and tells you there. Step 2 then turns on here by itself.
                  </p>
                  <KeysMessage />
                </Part>
              </ol>
            </>
          )}
        </li>

        <li className={`panel gs-step ${!keysIn ? "later" : accounts.length ? "done" : "now"}`}>
          <div className="gs-step-head">
            <span className="gs-badge">{keysIn && accounts.length ? "Done" : "Step 2"}</span>
            <h3>Connect your Google account</h3>
          </div>
          {!keysIn ? (
            <p className="st-help">This turns on once Shruti has added the keys from Step 1. Nothing to do until she tells you.</p>
          ) : (
            <>
              <p className="st-help">
                Click the button, pick your SPM account, leave <strong>every box ticked</strong> and click <strong>Allow</strong>. You come back here with it connected. For another of your accounts, do the same again.
              </p>
              {accounts.length > 0 && (
                <p className="st-help">
                  Connected: <strong>{accounts.map((a) => a.email).join(", ")}</strong>.
                </p>
              )}
              <div className="gs-row">
                <a className="btn primary" href="/api/google/start">
                  {accounts.length ? "Connect another Google account" : "Connect Google"}
                </a>
                <Link className="btn" href="/emails">
                  See your emails
                </Link>
                <Link className="btn" href="/calendar">
                  See your calendar
                </Link>
              </div>
              <Sketch
                url="accounts.google.com"
                caption="Google's own page: pick the account, keep every box ticked, click Allow."
                parts={[
                  { t: "title", text: "SPM Command Center wants access to your Google Account" },
                  { t: "check", label: "Read your email", hi: true },
                  { t: "check", label: "Send email on your behalf", hi: true },
                  { t: "check", label: "View and edit events on your calendars", hi: true },
                  { t: "buttons", items: [{ label: "Cancel" }, { label: "Allow", primary: true, hi: true }] },
                ]}
              />
            </>
          )}
        </li>
      </ol>

      <div className="panel gs-help">
        <h3>If something goes wrong</h3>
        <ul>
          <li>
            <strong>&quot;Access blocked&quot; or &quot;your admin has blocked this app&quot;:</strong> in the Google Admin console, open{" "}
            <a href="https://admin.google.com/ac/owl" target="_blank" rel="noopener noreferrer">
              API controls
            </a>{" "}
            and turn on <strong>Trust internal, domain-owned apps</strong>.
          </li>
          <li>
            <strong>&quot;redirect_uri_mismatch&quot;:</strong> the address in part 5 is missing or different. Open the client under Clients and check it reads exactly <code>{callback}</code>.
          </li>
          <li>
            <strong>Something else:</strong> send Shruti a screenshot in #spm-development.
          </li>
        </ul>
      </div>
    </section>
  );
}
