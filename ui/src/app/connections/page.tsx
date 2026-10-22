"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Pill } from "@/components/bits";
import { SecretField } from "@/components/SecretField";
import { ago } from "@/core/dates";
import {
  checkFathomKey, checkPhone, checkSlackToken, checkTelegramCode, FATHOM_API_ACCESS_URL, PROVIDER_ABOUT, PROVIDER_NAME, PROVIDERS, SLACK_CREATE_APP_URL, SLACK_USER_SCOPES,
} from "@/core/providers";
import type { JobId, Provider } from "@/core/types";
import { disconnectGoogle, disconnectProvider, disconnectTelegram, refresh, saveAppKeys, telegramStep, toast, useApp, type App, type TelegramReply } from "@/store/store";

const BADGE: Record<Provider, string> = { slack: "SL", telegram: "TG", fathom: "FA", google: "GO" };
// The check that reads each service, shown on its card.
const READER: Partial<Record<Provider, JobId>> = { slack: "slack-pull", telegram: "telegram-pull", fathom: "fathom-pull", google: "gmail-pull" };

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

function SlackSteps() {
  return (
    <ol className="steps">
      <Step title="Create the Slack app" help="Pick the Social Profit Media Clients workspace, click Next, then Create. The app is only a key holder. It is not a bot, and your replies are sent from your own account.">
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
      <Step title="Create an API key in Fathom" help="In Fathom's Settings, under API Access: click Add, then Generate API Key, name it Command Center, and copy the key straight away: Fathom shows it only once.">
        <ExternalLink href={FATHOM_API_ACCESS_URL}>Open Fathom: API Access</ExternalLink>
      </Step>
      <Step title="Paste the key" help="The key sees what you can see in Fathom: your own calls and the ones shared with you.">
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
function TelegramSteps({ local }: { local?: boolean }) {
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
        {local ? (
          <>
            <strong>This stays on this machine.</strong> The login is saved encrypted in the local database, with the chats. Nothing from Telegram reaches the hosted database or the live site.
          </>
        ) : (
          <>
            <strong>You log in yourself.</strong> Nobody else needs your code or password, and neither is kept. The login is stored encrypted, the same way as the Slack token, and you can end it here at any time.
          </>
        )}{" "}
        One-to-one chats come in, and a group only when someone tags you or replies to you. Channels and bots are left out.
      </div>
    </>
  );
}

/**
 * Google is one button. The person picks their account on Google's own page and clicks Allow,
 * and Google sends them back here. How it went comes back in the address (see `GoogleOutcome`).
 */
function GoogleSteps() {
  return (
    <ol className="steps">
      <Step title="Google's app keys" help="Done: the team's keys are in place on this site, so there is nothing to set up in Google Cloud." />
      <Step
        title="Connect your Google account"
        help="Google opens its own page: pick your socialprofitmedia.co account and click Allow, with every box ticked. The Command Center reads your inbox and your calendar. It sends an email, or adds, changes or answers an event, only when you do it here. It never deletes an email."
      >
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <a className="btn primary extlink" href="/api/google/start">
            Connect Google
          </a>
          <Link className="btn" href="/connections/google">
            The step-by-step guide
          </Link>
        </div>
      </Step>
    </ol>
  );
}

/**
 * The Google accounts that are connected, each with what it allowed and its own Disconnect,
 * and a button to add another. A second account goes through the same page at Google.
 */
function GoogleConnected({ app, lastChecked }: { app: App; lastChecked: string }) {
  const accounts = app.state.googleAccounts;
  const date = (ms: number) => new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return (
    <>
      <div className="st-help">
        {lastChecked} Emails come in from the moment an account is connected. Replies and new emails go out from the account, like Slack replies, and only while sending is on. Change how often in <Link href="/settings#timers">Settings, Timers</Link>.
      </div>
      <ul className="g-accounts">
        {accounts.map((a) => (
          <li key={a.email} className="connected-row">
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{a.email}</div>
              <div className="st-help">
                Since {date(a.connectedAt)} · {[a.gmail ? "reads Gmail" : null, a.send ? "sends email" : null, a.calendar ? "reads Calendar" : null, a.addEvents ? "adds events" : null].filter(Boolean).join(", ") || "nothing allowed"}
                {!(a.gmail && a.send && a.calendar && a.addEvents) && (
                  <>
                    {" "}
                    · <a href="/api/google/start">Connect it again</a> and tick every box to also{" "}
                    {[!a.gmail && "read Gmail", !a.send && "send email", !a.calendar && "read Calendar", !a.addEvents && "add events"].filter(Boolean).join(", ")}
                  </>
                )}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="btn" onClick={() => void disconnectGoogle(a.email, false)}>
                Disconnect
              </button>
              <button className="btn" onClick={() => void disconnectGoogle(a.email, true)}>
                Disconnect and remove its emails
              </button>
            </div>
          </li>
        ))}
      </ul>
      <div>
        <a className="btn extlink" href="/api/google/start">
          Add another Google account
        </a>
      </div>
      <div className="st-help">{TURN_OFF.google}</div>
    </>
  );
}

/** Google before it is switched on for this site, said the way Telegram says it. */
function GoogleNotReady({ why, noKeys }: { why: string | null; noKeys: boolean }) {
  if (!noKeys) return <div className="st-help">{why}</div>;
  return (
    <>
      <ol className="steps">
        <Step title="Set up Google Cloud" help="About 10 minutes in your Google account, once. The guide shows every click, with pictures. It ends with two keys: a Client ID and a Client secret.">
          <Link className="btn primary" href="/connections/google">
            Open the step-by-step guide
          </Link>
        </Step>
        <Step title="Save the two keys here" help="The Client ID and Client secret from the guide's last part. They are checked with Google, then stored encrypted. Everyone on the team connects with them.">
          <KeyForm app="google" />
        </Step>
        <Step title="Connect your Google account" help="The Connect Google button appears here as soon as the keys are saved." />
      </ol>
      {why && (
        <details className="fallback">
          <summary>What is missing, for whoever sets it up</summary>
          <div className="st-help">{why}</div>
        </details>
      )}
    </>
  );
}

/**
 * After Google or Slack sends the person back: says how it went, once, then takes it out of the
 * address so a reload does not say it again.
 */
function ConnectOutcome({ service }: { service: "google" | "slack" }) {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    if (!query.has(service) && !query.has(`${service}_error`)) return;
    const failed = query.get(`${service}_error`);
    window.history.replaceState(null, "", window.location.pathname + window.location.hash);
    if (failed) {
      // Shown once the page has drawn, not while it is drawing.
      queueMicrotask(() => setError(failed));
      return;
    }
    const account = query.get("account");
    toast(service === "google" ? `Google connected${account ? `: ${account}` : ""}. Reading the inbox and calendar now.` : "Slack connected. Reading your messages now.");
    void refresh();
    // The first read runs on the server after the way back; look again once it has had time.
    const later = setTimeout(() => void refresh(), 15_000);
    return () => clearTimeout(later);
  }, [service]);
  if (!error) return null;
  return (
    <div className="panel" role="alert" style={{ borderColor: "var(--bad)", background: "var(--bad-soft)", padding: "12px 16px", marginBottom: 14 }}>
      <strong>{service === "google" ? "Google" : "Slack"} was not connected.</strong> {error}
    </div>
  );
}

/**
 * Slack, when the team has one Slack app set up: one click, and Slack's own page to allow it. The
 * person gets a token of their own. Pasting a token stays as the other way.
 */
function SlackOneClick() {
  return (
    <ol className="steps">
      <Step title="Connect Slack" help="Slack opens its own page: check it shows the Social Profit Media Clients workspace at the top right, and click Allow. Your messages are read, and your replies sent, as you.">
        <div className="gs-row">
          <a className="btn primary" href="/api/slack/start">
            Connect Slack
          </a>
        </div>
      </Step>
      <li className="steps-plain">
        <details className="fallback">
          <summary>Or paste a token instead</summary>
          <SlackSteps />
        </details>
      </li>
    </ol>
  );
}

/**
 * For the owner: one Slack app for the whole team, so everyone connects with one click instead
 * of making an app of their own. Its Client ID and Client Secret are kept encrypted.
 */
function TeamSlackApp({ app }: { app: App }) {
  const keys = app.state.appKeys.slack;
  const site = typeof window === "undefined" ? "" : window.location.origin;
  if (keys.using === "own") return <div className="st-help">Team members connect Slack with one click, through your Slack app ({keys.label}).</div>;
  return (
    <details className="fallback">
      <summary>Let the team connect Slack with one click</summary>
      <div className="st-help">
        Instead of each person making a Slack app, everyone can use yours. On{" "}
        <ExternalLink href="https://api.slack.com/apps">api.slack.com/apps</ExternalLink>, open your app (SPM Command Center):
      </div>
      <ol className="gs-list st-help">
        <li>
          <strong>OAuth &amp; Permissions</strong>, under <strong>Redirect URLs</strong>: click Add New Redirect URL, paste <code>{site}/api/slack/callback</code>, click Add, then <strong>Save URLs</strong>.
        </li>
        <li>
          <strong>Basic Information</strong>, under App Credentials: copy the <strong>Client ID</strong>, and the <strong>Client Secret</strong> (click Show). Paste both here. Don&apos;t click Regenerate.
        </li>
      </ol>
      <div className="st-help">Your own Slack connection is not touched, and nobody else sees your messages.</div>
      <KeyForm app="slack" />
    </details>
  );
}

const STEPS: Record<Provider, (props: { local?: boolean }) => React.ReactNode> = { slack: SlackSteps, telegram: TelegramSteps, fathom: FathomSteps, google: GoogleSteps };

const TURN_OFF: Record<Provider, string> = {
  slack: "Disconnecting removes the stored token and stops the Command Center reading Slack. To remove the access for good, also delete the app in Slack.",
  telegram: "Disconnecting signs this connection out of Telegram and deletes the saved login. The chats already read stay in the dashboard unless you also remove them. You can check it is gone in Telegram under Settings, Devices.",
  fathom: "Disconnecting removes the stored key and stops new calls coming in. To remove the access for good, also delete the key in Fathom.",
  google: "Disconnecting ends the login on Google's side too and deletes it here. The emails already read stay in the dashboard unless you also remove them. You can check it is gone in your Google Account under Security, Your connections to third-party apps.",
};

/**
 * Telegram before it is switched on for this site. A person looking for the login is told it
 * is on its way. Whoever sets the server up is told exactly what is missing.
 */
function TelegramNotReady({ why, noKeys }: { why: string | null; noKeys: boolean }) {
  if (!noKeys) return <div className="st-help">{why}</div>;
  return (
    <>
      <div className="st-help">
        <strong>Telegram needs its app keys first.</strong> Get an api_id and api_hash at <ExternalLink href="https://my.telegram.org/apps">my.telegram.org</ExternalLink>, under API development tools, and
        save them here. Everyone on the team then logs in with them: your phone number, then the code Telegram sends you.
      </div>
      <KeyForm app="telegram" />
      {why && (
        <details className="fallback">
          <summary>What is missing, for whoever sets it up</summary>
          <div className="st-help">{why}</div>
        </details>
      )}
    </>
  );
}

function ProviderCard({ provider, app }: { provider: Provider; app: App }) {
  const connection = app.state.connections[provider];
  const Steps = STEPS[provider];
  const notReady = (provider === "telegram" && !app.state.telegramAvailable) || (provider === "google" && !app.state.googleAvailable);
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
        {connection.connected ? <Pill tone="s-ok">Connected</Pill> : <Pill tone="p-low">{notReady ? "Not switched on yet" : "Not connected"}</Pill>}
      </div>
      <div className="prov-body">
        {provider === "google" && connection.connected ? (
          <GoogleConnected app={app} lastChecked={status?.lastRunAt ? `Last checked ${ago(status.lastRunAt, app.now.getTime())} ago: ${status.message ?? (status.ok ? "done" : "failed")}.` : "Not checked yet."} />
        ) : connection.connected ? (
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
          notReady ? (
            provider === "google" ? (
              <GoogleNotReady why={app.state.googleBlocked} noKeys={app.state.appKeys.google.using === null} />
            ) : (
              <TelegramNotReady why={app.state.telegramBlocked} noKeys={app.state.appKeys.telegram.using === null} />
            )
          ) : (
            <>
              {provider !== "google" && (
                <p className="st-help guide-link">
                  New to this? <Link href={`/connections/${provider}`}>Open the step-by-step guide, with pictures</Link>.
                </p>
              )}
              {provider === "slack" && app.state.appKeys.slack.using ? <SlackOneClick /> : <Steps local={app.state.localData} />}
            </>
          )
        )}
        {provider === "slack" && app.state.me.isOwner && <TeamSlackApp app={app} />}
      </div>
    </div>
  );
}

type KeyApp = "google" | "telegram" | "slack";

/** The fields of each app's keys. */
const KEY_FIELDS: Record<KeyApp, { key: string; label: string; placeholder: string; secret: boolean }[]> = {
  google: [
    { key: "clientId", label: "Client ID", placeholder: "…apps.googleusercontent.com", secret: false },
    { key: "clientSecret", label: "Client secret", placeholder: "GOCSPX-…", secret: true },
  ],
  telegram: [
    { key: "apiId", label: "api_id", placeholder: "Digits only", secret: false },
    { key: "apiHash", label: "api_hash", placeholder: "32 letters and digits", secret: true },
  ],
  slack: [
    { key: "clientId", label: "Client ID", placeholder: "1234567890.1234567890", secret: false },
    { key: "clientSecret", label: "Client Secret", placeholder: "32 letters and digits", secret: true },
  ],
};

/**
 * Saving an app's keys, shown only where there are none at all yet: everyone else connects
 * with the team's. Checked where they can be, stored encrypted, and never shown again.
 */
function KeyForm({ app }: { app: KeyApp }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="key-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const refused = await saveAppKeys(app, values);
        setBusy(false);
        setError(refused);
        if (!refused) setValues({});
      }}
    >
      {KEY_FIELDS[app].map((f) => (
        <label key={f.key} className="key-field">
          <span className="label">{f.label}</span>
          <input
            className="f"
            type={f.secret ? "password" : "text"}
            autoComplete="off"
            spellCheck={false}
            value={values[f.key] ?? ""}
            placeholder={f.placeholder}
            onChange={(e) => {
              setValues({ ...values, [f.key]: e.target.value });
              setError(null);
            }}
          />
        </label>
      ))}
      <div className="key-form-acts">
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? "Checking…" : "Save the keys"}
        </button>
      </div>
      {error && (
        <div className="field-error" role="alert">
          {error}
        </div>
      )}
    </form>
  );
}

export default function ConnectionsPage() {
  const app = useApp();
  if (!app) return null;
  const connected = PROVIDERS.filter((p) => app.state.connections[p].connected).length;

  return (
    <section className="view">
      <div className="view-head">
        <div>
          <h2>Connections</h2>
          <div className="muted" style={{ fontSize: 14 }}>
            Connect the places your messages and calls come from. {connected} of {PROVIDERS.length} connected. A key you paste here is checked, stored encrypted, and never shown again.
          </div>
        </div>
      </div>
      <ConnectOutcome service="google" />
      <ConnectOutcome service="slack" />
      <div className="prov-list">
        {PROVIDERS.map((p) => (
          <ProviderCard key={p} provider={p} app={app} />
        ))}
      </div>
      <p className="muted" style={{ fontSize: 13.5, marginTop: 16 }}>
        Coming later: WhatsApp.
      </p>
    </section>
  );
}
