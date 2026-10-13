"use client";

import Link from "next/link";
import { useState } from "react";
import { Pill } from "@/components/bits";
import { ago } from "@/core/dates";
import {
  checkFathomKey, checkPhone, checkSlackToken, checkTelegramCode, FATHOM_API_ACCESS_URL, liveProviders, PROVIDER_ABOUT, PROVIDER_NAME, SLACK_CREATE_APP_URL, SLACK_USER_SCOPES,
} from "@/core/providers";
import type { JobId, Provider } from "@/core/types";
import { connectProvider, disconnectProvider, disconnectTelegram, telegramStep, useApp, type App, type TelegramReply } from "@/store/store";

const BADGE: Record<Provider, string> = { slack: "SL", telegram: "TG", fathom: "FA" };
// The check that reads each service, shown on its card.
const READER: Partial<Record<Provider, JobId>> = { slack: "slack-pull", telegram: "telegram-pull", fathom: "fathom-pull" };

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

type TelegramStage = "phone" | "code" | "password";

const TELEGRAM_FIELD: Record<TelegramStage, { label: string; placeholder: string; type: string; button: string; check(value: string): string | null }> = {
  phone: { label: "Phone number", placeholder: "+44 7700 900123", type: "tel", button: "Send me the code", check: checkPhone },
  code: { label: "Code from Telegram", placeholder: "12345", type: "text", button: "Continue", check: checkTelegramCode },
  password: { label: "Telegram password", placeholder: "Your Telegram password", type: "password", button: "Connect Telegram", check: (v) => (v ? null : "Type your Telegram password.") },
};

/**
 * Logging in to Telegram, the same as on a new device: the phone number, then the code
 * Telegram sends, then the account's password if it has one. Each answer goes to the server
 * on this machine once and is not kept in the browser.
 */
function TelegramSteps() {
  const [stage, setStage] = useState<TelegramStage>("phone");
  /** Where Telegram sent the code: inside Telegram, by text message, or to an email address. */
  const [sentTo, setSentTo] = useState<"app" | "sms" | string>("app");
  const [hint, setHint] = useState<string | undefined>();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = TELEGRAM_FIELD[stage];

  const take = (reply: TelegramReply) => {
    setBusy(false);
    if ("failed" in reply) {
      setError(reply.failed);
      // A login that has ended on the server starts over from the phone number.
      if (stage !== "phone" && /start again|timed out|cancelled|wait/i.test(reply.failed)) setStage("phone");
      return;
    }
    setValue("");
    if ("connected" in reply) return;
    setError(reply.error ?? null);
    if (reply.need === "code") setSentTo(reply.email ?? (reply.viaApp ? "app" : "sms"));
    else setHint(reply.hint);
    setStage(reply.need);
  };

  const form = (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const problem = field.check(value);
        setError(problem);
        if (problem) return;
        setBusy(true);
        take(await telegramStep(stage === "phone" ? { step: "start", phone: value } : stage === "code" ? { step: "code", code: value.trim() } : { step: "password", password: value }));
      }}
    >
      <div className="key-row">
        <input
          className="f"
          id="telegram-field"
          type={field.type}
          inputMode={stage === "code" ? "numeric" : undefined}
          autoComplete={stage === "code" ? "one-time-code" : "off"}
          spellCheck={false}
          value={value}
          placeholder={field.placeholder}
          aria-label={field.label}
          aria-invalid={error != null}
          aria-describedby={error ? "telegram-field-error" : undefined}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
        />
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? "Checking…" : field.button}
        </button>
        {stage !== "phone" && (
          <button
            className="btn"
            type="button"
            disabled={busy}
            onClick={() => {
              void telegramStep({ step: "cancel" });
              setStage("phone");
              setValue("");
              setError(null);
            }}
          >
            Start again
          </button>
        )}
      </div>
      {error && (
        <div className="field-error" id="telegram-field-error" role="alert">
          {error}
        </div>
      )}
    </form>
  );

  return (
    <>
      <ol className="steps">
        <Step title="Type your phone number" help="The number your Telegram account uses, with its country code. Telegram then sends a login code, the same as logging in on a new device.">
          {stage === "phone" && form}
        </Step>
        <Step
          title="Type the code Telegram sends"
          help={
            stage === "phone"
              ? "It arrives inside Telegram, in the chat called Telegram."
              : sentTo === "app"
                ? "Open Telegram on your phone or computer. The code is in the chat called Telegram. Type it here; do not send it to anyone."
                : sentTo === "sms"
                  ? "Telegram sent the code to your phone as a text message."
                  : `Telegram sent the code to the email on your account (${sentTo}).`
          }
        >
          {stage === "code" && form}
        </Step>
        {stage === "password" && (
          <Step title="Type your Telegram password" help={`This account has two-step verification, so Telegram also asks for the password you set there${hint ? ` (your hint: ${hint})` : ""}. It is used once to log in and is not stored.`}>
            {form}
          </Step>
        )}
      </ol>
      <div className="st-help">
        <strong>This stays on this machine.</strong> The login is saved encrypted in a file here, and the chats go into the local database only. Nothing from Telegram reaches the hosted database or the live site. One-to-one chats come in, and a group only when someone tags you or replies to you. Channels and bots are left out.
      </div>
    </>
  );
}

const STEPS: Record<Provider, () => React.ReactNode> = { slack: SlackSteps, telegram: TelegramSteps, fathom: FathomSteps };

const TURN_OFF: Record<Provider, string> = {
  slack: "Disconnecting removes the stored token and stops the Command Center reading Slack. To remove the access for good, also delete the app in Slack.",
  telegram: "Disconnecting signs this connection out of Telegram and deletes the saved login from this machine. The chats already read stay in the local database unless you also remove them. You can check it is gone in Telegram under Settings, Devices.",
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
        {connection.connected ? <Pill tone="s-ok">Connected</Pill> : <Pill tone="p-low">Not connected</Pill>}
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
              {provider === "telegram" ? (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button className="btn" onClick={() => void disconnectTelegram(false)}>
                    Disconnect
                  </button>
                  <button className="btn" onClick={() => void disconnectTelegram(true)}>
                    Disconnect and remove its chats
                  </button>
                </div>
              ) : (
                <button className="btn" onClick={() => disconnectProvider(provider)}>
                  Disconnect
                </button>
              )}
            </div>
            {provider === "slack" && app.state.slackFilesAllowed === false && (
              <div className="st-help">
                <strong>Pictures from Slack are not shown yet.</strong> The Slack app is missing one permission. In Slack, open the app&apos;s page, go to OAuth &amp; Permissions, add <code>files:read</code> under <strong>User Token Scopes</strong>, then click Reinstall. If the User OAuth Token changed, disconnect here and paste the new one. Reactions already show.
              </div>
            )}
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
  const providers = liveProviders(app.state.telegramAvailable);
  const connected = providers.filter((p) => app.state.connections[p].connected).length;

  return (
    <section className="view">
      <div className="view-head">
        <div>
          <h2>Connections</h2>
          <div className="muted" style={{ fontSize: 14 }}>
            Connect the places your messages and calls come from. {connected} of {providers.length} connected. A key you paste here is checked, stored encrypted, and never shown again.
          </div>
        </div>
      </div>
      <div className="prov-list">
        {providers.map((p) => (
          <ProviderCard key={p} provider={p} app={app} />
        ))}
      </div>
      <p className="muted" style={{ fontSize: 13.5, marginTop: 16 }}>
        Coming later: {app.state.telegramAvailable ? "" : "Telegram, "}Email, Calendar and WhatsApp.
      </p>
    </section>
  );
}
