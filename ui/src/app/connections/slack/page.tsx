"use client";

import Link from "next/link";
import { GuidePart as Part, Open, Sketch } from "@/components/Guide";
import { SecretField } from "@/components/SecretField";
import { checkSlackToken, SLACK_CREATE_APP_URL, SLACK_USER_SCOPES, SLACK_WORKSPACE } from "@/core/providers";
import { useApp } from "@/store/store";

// The guide for connecting Slack, for anyone on the team. When the team has one Slack app set up
// (its keys saved by the owner), it is one click: Connect Slack, then Allow on Slack's page, and
// the person gets a token of their own. Otherwise, or if they would rather, each person makes a
// small Slack app of their own in the team's workspace (it only holds the key; it is not a bot) and
// pastes its token here.

export default function SlackSetupPage() {
  const app = useApp();
  if (!app) return null;
  const connected = app.state.connections.slack.connected;
  const oneClick = app.state.appKeys.slack.using !== null;

  return (
    <section className="view gs">
      <div className="view-head">
        <div>
          <Link href="/connections#slack" className="srclink">
            ← Connections
          </Link>
          <h2>Connecting Slack</h2>
          <div className="muted" style={{ fontSize: 14, maxWidth: "70ch" }}>
            So your Slack messages show in your inbox, and you can answer them from here. Your replies are sent from your own Slack account, as you.{" "}
            {oneClick ? (
              <>
                The team has one Slack app already, so it is <strong>one click</strong>: Connect Slack, then Allow.
              </>
            ) : (
              <>
                It takes about 5 minutes, once: <strong>Step 1</strong> makes a small Slack app that holds your key, <strong>Step 2</strong> pastes the key here.
              </>
            )}
          </div>
        </div>
      </div>

      <ol className="gs-steps">
        {oneClick && (
          <li className={`panel gs-step ${connected ? "done" : "now"}`}>
            <div className="gs-step-head">
              <span className="gs-badge">{connected ? "Done" : "One click"}</span>
              <h3>Connect Slack</h3>
            </div>
            {connected ? (
              <p className="st-help">
                Connected as <strong>{app.state.connections.slack.label}</strong>.
              </p>
            ) : (
              <>
                <p className="st-help">
                  The team has one Slack app, so there is nothing to make. Click the button: Slack opens its own page. Check it shows <strong>{SLACK_WORKSPACE}</strong> at the top right (if not,
                  switch workspace there), then click <strong>Allow</strong>. You come back here connected, with a token of your own: your replies are sent as you.
                </p>
                <div className="gs-row">
                  <a className="btn primary" href="/api/slack/start">
                    Connect Slack
                  </a>
                </div>
                <Sketch
                  url="slack.com/oauth"
                  caption={`Slack's own page: check the workspace is ${SLACK_WORKSPACE}, then Allow.`}
                  parts={[
                    { t: "topbar", brand: "Slack", project: SLACK_WORKSPACE },
                    { t: "title", text: `The team's Slack app is requesting permission to access the ${SLACK_WORKSPACE} Slack workspace` },
                    { t: "text", text: "View messages and other content · Send messages on your behalf · View people in the workspace" },
                    { t: "buttons", items: [{ label: "Cancel" }, { label: "Allow", primary: true, hi: true }] },
                  ]}
                />
              </>
            )}
          </li>
        )}
        {oneClick && !connected && (
          <li className="panel gs-step later">
            <div className="gs-step-head">
              <span className="gs-badge">Or</span>
              <h3>Make an app of your own instead</h3>
            </div>
            <p className="st-help">Only if Connect Slack does not work for you. The steps below make a small Slack app that is yours alone, then you paste its key.</p>
          </li>
        )}
        {(!oneClick || !connected) && (
          <>
            <li className={`panel gs-step ${connected ? "done" : oneClick ? "later" : "now"}`}>
              <div className="gs-step-head">
                <span className="gs-badge">{connected ? "Done" : "Step 1"}</span>
                <h3>Make your Slack app</h3>
              </div>
              {connected ? (
                <p className="st-help">Slack is connected. Nothing more to do here.</p>
              ) : (
                <>
                  <p className="st-help">
                    Do this on a computer, signed in to Slack in your browser, in the <strong>{SLACK_WORKSPACE}</strong> workspace. The button below opens Slack with everything filled in already.
                  </p>
                  <ol className="gs-parts">
                    <Part n="1" title="Create the app">
                      <p>
                        Open the page. Slack asks which workspace: pick <strong>{SLACK_WORKSPACE}</strong> and click <strong>Next</strong>. It then shows the app&apos;s settings, filled in: click{" "}
                        <strong>Next</strong>, then <strong>Create</strong>.
                      </p>
                      <Open href={SLACK_CREATE_APP_URL}>Open Slack: create the app</Open>
                      <Sketch
                        url="api.slack.com/apps"
                        caption={`Pick the ${SLACK_WORKSPACE} workspace, then Next.`}
                        parts={[
                          { t: "topbar", brand: "Slack API" },
                          { t: "title", text: "Create an app from a manifest" },
                          { t: "field", label: "Pick a workspace to develop your app in", value: `${SLACK_WORKSPACE} ▾`, hi: true },
                          { t: "buttons", items: [{ label: "Cancel" }, { label: "Next", primary: true, hi: true }] },
                        ]}
                      />
                      <Sketch
                        url="api.slack.com/apps"
                        caption="The settings are filled in already: Next, then Create."
                        parts={[
                          { t: "topbar", brand: "Slack API" },
                          { t: "title", text: "Review summary & create your app" },
                          { t: "text", text: "SPM Command Center · User token scopes: channels:history, im:history, chat:write, search:read and more" },
                          { t: "buttons", items: [{ label: "Back" }, { label: "Create", primary: true, hi: true }] },
                        ]}
                      />
                    </Part>
                    <Part n="2" title="Install it in the workspace">
                      <p>
                        You land on the app&apos;s page. In the menu on the left, open <strong>OAuth &amp; Permissions</strong>. Under <strong>OAuth Tokens</strong>, click{" "}
                        <strong>Install to {SLACK_WORKSPACE}</strong>, then <strong>Allow</strong> on the next page.
                      </p>
                      <p>
                        If the button says <strong>Request to Install</strong> instead, the workspace wants an admin to approve apps: click it, ask Jeremy to approve it in Slack, then come back here
                        and click <strong>Install to {SLACK_WORKSPACE}</strong>.
                      </p>
                      <Sketch
                        url="api.slack.com/apps › OAuth & Permissions"
                        caption={`OAuth & Permissions, then Install to ${SLACK_WORKSPACE}.`}
                        parts={[
                          { t: "topbar", brand: "Slack API" },
                          { t: "menu", items: ["Basic Information", "OAuth & Permissions", "Event Subscriptions", "App Home"], picked: 1 },
                          { t: "title", text: "OAuth Tokens" },
                          { t: "buttons", items: [{ label: `Install to ${SLACK_WORKSPACE}`, primary: true, hi: true }] },
                        ]}
                      />
                      <Sketch
                        url="slack.com/oauth"
                        caption="Slack asks if the app may act as you: Allow."
                        parts={[
                          { t: "title", text: `SPM Command Center is requesting permission to access the ${SLACK_WORKSPACE} Slack workspace` },
                          { t: "text", text: "View messages and other content · Send messages on your behalf · View people in the workspace" },
                          { t: "buttons", items: [{ label: "Cancel" }, { label: "Allow", primary: true, hi: true }] },
                        ]}
                      />
                      <details className="fallback">
                        <summary>If Slack asks you to add scopes first</summary>
                        <div className="st-help">
                          The app was made without its permissions. On the same page, scroll to Scopes and find <strong>User Token Scopes</strong> (not Bot Token Scopes). Click Add an OAuth Scope and
                          add each of these, then install:
                        </div>
                        <ul className="scopes">
                          {SLACK_USER_SCOPES.map((scope) => (
                            <li key={scope}>
                              <code>{scope}</code>
                            </li>
                          ))}
                        </ul>
                      </details>
                    </Part>
                    <Part n="3" title="Copy your key">
                      <p>
                        Back on <strong>OAuth &amp; Permissions</strong>, under OAuth Tokens, there is now a <strong>User OAuth Token</strong>. It starts with <code>xoxp-</code>. Click{" "}
                        <strong>Copy</strong>. If you also see a Bot User OAuth Token (<code>xoxb-</code>), that is not the one.
                      </p>
                      <Sketch
                        url="api.slack.com/apps › OAuth & Permissions"
                        caption="Copy the User OAuth Token: the one that starts with xoxp-."
                        parts={[
                          { t: "topbar", brand: "Slack API" },
                          { t: "title", text: "OAuth Tokens" },
                          { t: "field", label: "User OAuth Token", value: "xoxp-••••••••••••••  Copy", hi: true },
                        ]}
                      />
                    </Part>
                  </ol>
                </>
              )}
            </li>

            <li className={`panel gs-step ${connected ? "done" : oneClick ? "later" : "now"}`}>
              <div className="gs-step-head">
                <span className="gs-badge">{connected ? "Done" : "Step 2"}</span>
                <h3>Paste the key here</h3>
              </div>
              {connected ? (
                <p className="st-help">
                  Connected as <strong>{app.state.connections.slack.label}</strong>. Pick the channels to follow in <Link href="/settings#channels">Settings, Slack channels</Link>.
                </p>
              ) : (
                <>
                  <p className="st-help">It is checked with Slack, then stored encrypted. Your messages start coming in straight away.</p>
                  <SecretField provider="slack" label="Slack token" placeholder="xoxp-…" check={checkSlackToken} />
                </>
              )}
            </li>
          </>
        )}
        <li className={`panel gs-step ${connected ? "now" : "later"}`}>
          <div className="gs-step-head">
            <span className="gs-badge">Then</span>
            <h3>Pick what matters</h3>
          </div>
          <p className="st-help">
            Direct messages and anything that tags you come in by themselves. In <Link href="/settings#channels">Settings, Slack channels</Link>, tick the channels you want to follow as well. In{" "}
            <Link href="/settings#important">Settings, Important</Link>, tick the channels and people whose messages go to the top of your inbox.
          </p>
        </li>
      </ol>

      <div className="panel gs-help">
        <h3>If something goes wrong</h3>
        <ul>
          <li>
            <strong>&quot;Slack did not accept that token&quot;:</strong> copy the User OAuth Token again, the whole of it, starting with <code>xoxp-</code>.
          </li>
          <li>
            <strong>The install button says Request to Install:</strong> an admin has to approve it first. Ask Jeremy.
          </li>
          <li>
            <strong>Pictures from Slack don&apos;t show:</strong> the app needs <code>files:read</code> under User Token Scopes. Add it, click Reinstall, and paste the new token if it changed.
          </li>
          <li>
            <strong>Pictures can&apos;t be sent from the dashboard:</strong> the app needs <code>files:write</code> under User Token Scopes. Add it, click Reinstall, and paste the new token if it changed.
          </li>
          <li>
            <strong>Something else:</strong> send Shruti a screenshot in #spm-development.
          </li>
        </ul>
      </div>
    </section>
  );
}
