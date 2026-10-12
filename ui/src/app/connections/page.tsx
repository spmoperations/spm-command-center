"use client";

import Link from "next/link";
import { useState } from "react";
import { Pill } from "@/components/bits";
import { ago } from "@/core/dates";
import {
  checkFathomKey, checkSlackToken, FATHOM_API_ACCESS_URL, LIVE_PROVIDERS, PROVIDER_ABOUT, PROVIDER_NAME, SLACK_CREATE_APP_URL, SLACK_USER_SCOPES,
} from "@/core/providers";
import type { JobId, Provider } from "@/core/types";
import { connectProvider, disconnectProvider, useApp, type App } from "@/store/store";

const BADGE: Record<Provider, string> = { slack: "SL", telegram: "TG", fathom: "FA" };
// The check that reads each service, shown on its card.
const READER: Partial<Record<Provider, JobId>> = { slack: "slack-pull", fathom: "fathom-pull" };

function Step({ title, help, children }: { title: string; help?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <li>
      <div className="st-body">
        <div>
          <div className="st-title">{title}</div>
          {help && <div className="st-help">{help}</div>}
        </div>
        {children}
      </div>
    </li>
  );
}

const ExternalLink = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <a className="btn extlink" href={href} target="_blank" rel="noopener noreferrer">
    {children} ↗
  </a>
);

/** A field for a key or token. It is sent to the server once and never kept in the browser. */
function SecretField({ provider, label, placeholder, check }: { provider: Provider; label: string; placeholder: string; check(value: string): string | null }) {
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

function SlackSteps() {
  return (
    <ol className="steps">
      <Step title="Create the Slack app" help="Pick the SPM workspace, click Next, then Create. The app is only a key holder. It is not a bot, and your replies are sent from your own account.">
        <ExternalLink href={SLACK_CREATE_APP_URL}>Create the Slack app</ExternalLink>
      </Step>
      <Step title="Install it" help="On the app's page, open OAuth & Permissions, click Install to Workspace, then Allow.">
        <details className="fallback">
          <summary>If Slack asks you to add scopes first</summary>
          <div className="st-help">
            That means the app was created without its permissions. On the same page, scroll to Scopes and find <strong>User Token Scopes</strong>, not Bot Token Scopes. Click Add an OAuth Scope and add each of these, then install:
          </div>
          <ul className="scopes">
            {SLACK_USER_SCOPES.map((scope) => (
              <li key={scope}>
                <code>{scope}</code>
              </li>
            ))}
          </ul>
        </details>
      </Step>
      <Step title="Paste the token" help={<>Back on that page, look under OAuth Tokens and copy the <strong>User OAuth Token</strong>. It starts with <code>xoxp-</code>. If Slack also shows a Bot User OAuth Token (<code>xoxb-</code>), that is not the one.</>}>
        <SecretField provider="slack" label="Slack token" placeholder="xoxp-…" check={checkSlackToken} />
      </Step>
    </ol>
  );
}

function FathomSteps() {
  return (
    <ol className="steps">
      <Step title="Create an API key in Fathom" help="Open Fathom's settings at the part called API Access, create a new key and name it Command Center.">
        <ExternalLink href={FATHOM_API_ACCESS_URL}>Open Fathom: API Access</ExternalLink>
      </Step>
      <Step title="Paste the key" help="The key shows calls you recorded and calls shared with you.">
        <SecretField provider="fathom" label="Fathom API key" placeholder="Fathom API key" check={checkFathomKey} />
      </Step>
    </ol>
  );
}

const TelegramNote = () => (
  <div className="st-help">
    Telegram cannot be connected yet. It first needs its app keys, which are set up once on our side. After that you will log in here with your phone number and the code Telegram sends you, the same as logging in on a new device.
  </div>
);

const STEPS: Record<Provider, () => React.ReactNode> = { slack: SlackSteps, telegram: TelegramNote, fathom: FathomSteps };

const TURN_OFF: Record<Provider, string> = {
  slack: "Disconnecting removes the stored token and stops the Command Center reading Slack. To remove the access for good, also delete the app in Slack.",
  telegram: "Disconnecting stops the Command Center reading Telegram. To remove the access for good, also end the session in Telegram under Settings, Devices.",
  fathom: "Disconnecting removes the stored key and stops new calls coming in. To remove the access for good, also delete the key in Fathom.",
};

function ProviderCard({ provider, app }: { provider: Provider; app: App }) {
  const connection = app.state.connections[provider];
  const Steps = STEPS[provider];
  const reader = READER[provider];
  const status = reader ? app.state.jobStatus[reader] : undefined;
  const since = connection.connectedAt
    ? new Date(connection.connectedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : null;
  return (
    <div className="panel prov" id={provider}>
      <div className="prov-head">
        <span className={`src src-${provider}`} aria-hidden="true">
          {BADGE[provider]}
        </span>
        <div className="grow">
          <h3>{PROVIDER_NAME[provider]}</h3>
          <div className="about">{PROVIDER_ABOUT[provider]}</div>
        </div>
        {connection.connected ? <Pill tone="s-ok">Connected</Pill> : <Pill tone="p-low">{provider === "telegram" ? "Not available yet" : "Not connected"}</Pill>}
      </div>
      <div className="prov-body">
        {connection.connected ? (
          <>
            <div className="connected-row">
              <div>
                <div style={{ fontWeight: 600 }}>
                  {connection.label ?? "Connected"}
                  {since ? ` · since ${since}` : ""}
                </div>
                <div className="st-help">
                  {status?.lastRunAt
                    ? `Last checked ${ago(status.lastRunAt, app.now.getTime())} ago: ${status.message ?? (status.ok ? "done" : "failed")}. `
                    : "Not checked yet. "}
                  Change how often in <Link href="/settings#timers">Settings, Timers</Link>.
                </div>
              </div>
              <button className="btn" onClick={() => disconnectProvider(provider)}>
                Disconnect
              </button>
            </div>
            <div className="st-help">{TURN_OFF[provider]}</div>
          </>
        ) : (
          <Steps />
        )}
      </div>
    </div>
  );
}

export default function ConnectionsPage() {
  const app = useApp();
  if (!app) return null;
  const connected = LIVE_PROVIDERS.filter((p) => app.state.connections[p].connected).length;

  return (
    <section className="view">
      <div className="view-head">
        <div>
          <h2>Connections</h2>
          <div className="muted" style={{ fontSize: 14 }}>
            Connect the places your messages and calls come from. {connected} of {LIVE_PROVIDERS.length} connected. A key you paste here is checked, stored encrypted, and never shown again.
          </div>
        </div>
      </div>
      <div className="prov-list">
        {LIVE_PROVIDERS.map((p) => (
          <ProviderCard key={p} provider={p} app={app} />
        ))}
      </div>
      <p className="muted" style={{ fontSize: 13.5, marginTop: 16 }}>
        Coming later: Email, Calendar and WhatsApp.
      </p>
    </section>
  );
}
