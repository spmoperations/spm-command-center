"use client";

import Link from "next/link";
import { GuidePart as Part, Open, Sketch } from "@/components/Guide";
import { SecretField } from "@/components/SecretField";
import { checkFathomKey, FATHOM_API_ACCESS_URL } from "@/core/providers";
import { useApp } from "@/store/store";

// The guide for connecting Fathom, for anyone on the team: an API key made in Fathom's settings,
// pasted here. The key sees the calls the person recorded and the calls shared with them.

export default function FathomSetupPage() {
  const app = useApp();
  if (!app) return null;
  const connected = app.state.connections.fathom.connected;

  return (
    <section className="view gs">
      <div className="view-head">
        <div>
          <Link href="/connections#fathom" className="srclink">
            ← Connections
          </Link>
          <h2>Connecting Fathom</h2>
          <div className="muted" style={{ fontSize: 14, maxWidth: "70ch" }}>
            So your recorded calls show on the Meetings tab, with their notes, transcript and action items. It takes about 2 minutes: <strong>Step 1</strong> makes a key in Fathom,{" "}
            <strong>Step 2</strong> pastes it here.
          </div>
        </div>
      </div>

      <ol className="gs-steps">
        <li className={`panel gs-step ${connected ? "done" : "now"}`}>
          <div className="gs-step-head">
            <span className="gs-badge">{connected ? "Done" : "Step 1"}</span>
            <h3>Make an API key in Fathom</h3>
          </div>
          {connected ? (
            <p className="st-help">Fathom is connected. Nothing more to do here.</p>
          ) : (
            <ol className="gs-parts">
              <Part n="1" title="Open Fathom's API settings">
                <p>
                  Signed in to Fathom in your browser, open the page below. It goes straight to <strong>Settings</strong>, at the part called <strong>API Access</strong>.
                </p>
                <Open href={FATHOM_API_ACCESS_URL}>Open Fathom: API Access</Open>
              </Part>
              <Part n="2" title="Make the key and copy it">
                <p>
                  Click the button to add a new API key, name it <code>Command Center</code>, and create it. Fathom then shows the key: click <strong>Copy</strong> straight away, as it may not show it
                  again.
                </p>
                <Sketch
                  url="fathom.video › Settings › API Access"
                  caption="Add an API key, name it Command Center, create it."
                  parts={[
                    { t: "topbar", brand: "Fathom" },
                    { t: "menu", items: ["General", "Recording", "Integrations", "API Access"], picked: 3 },
                    { t: "title", text: "API Access" },
                    { t: "field", label: "Key name", value: "Command Center", hi: true },
                    { t: "buttons", items: [{ label: "Create key", primary: true, hi: true }] },
                  ]}
                />
                <Sketch
                  url="fathom.video › Settings › API Access"
                  caption="Copy the key it shows you."
                  parts={[
                    { t: "topbar", brand: "Fathom" },
                    { t: "title", text: "Your new API key" },
                    { t: "field", label: "Command Center", value: "••••••••••••••••••••  Copy", hi: true },
                  ]}
                />
              </Part>
            </ol>
          )}
        </li>

        <li className={`panel gs-step ${connected ? "done" : "now"}`}>
          <div className="gs-step-head">
            <span className="gs-badge">{connected ? "Done" : "Step 2"}</span>
            <h3>Paste the key here</h3>
          </div>
          {connected ? (
            <p className="st-help">
              Connected as <strong>{app.state.connections.fathom.label}</strong>. Your calls are on the <Link href="/meetings">Meetings</Link> tab.
            </p>
          ) : (
            <>
              <p className="st-help">It is checked with Fathom, then stored encrypted. Your calls come in on the next check.</p>
              <SecretField provider="fathom" label="Fathom API key" placeholder="Fathom API key" check={checkFathomKey} />
            </>
          )}
        </li>
      </ol>

      <div className="panel gs-help">
        <h3>Good to know</h3>
        <ul>
          <li>
            <strong>Which calls come in:</strong> the calls you recorded with Fathom, and the calls someone shared with you in Fathom. A call recorded by someone else shows up once they share it with you.
          </li>
          <li>
            <strong>&quot;Fathom did not accept that key&quot;:</strong> copy it again, the whole of it, or make a new one.
          </li>
          <li>
            <strong>Something else:</strong> send Shruti a screenshot in #spm-development.
          </li>
        </ul>
      </div>
    </section>
  );
}
