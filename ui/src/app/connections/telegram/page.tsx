"use client";

import Link from "next/link";
import { GuidePart as Part, Sketch } from "@/components/Guide";
import { useApp } from "@/store/store";

// The guide for connecting Telegram, for anyone on the team. Telegram is your own account, not a
// bot: you log in with your phone number and the code Telegram sends, the way a new phone would.
// The login itself happens in the Telegram card on the Connections page.

export default function TelegramSetupPage() {
  const app = useApp();
  if (!app) return null;
  const { state } = app;
  const connected = state.connections.telegram.connected;

  return (
    <section className="view gs">
      <div className="view-head">
        <div>
          <Link href="/connections#telegram" className="srclink">
            ← Connections
          </Link>
          <h2>Connecting Telegram</h2>
          <div className="muted" style={{ fontSize: 14, maxWidth: "70ch" }}>
            So your Telegram chats show in your inbox, and you can answer them from here. It takes about 2 minutes: you log in with your phone number and the code Telegram sends you, as on a new
            phone. Keep the Telegram app open on your phone or computer.
          </div>
        </div>
      </div>

      <ol className="gs-steps">
        <li className={`panel gs-step ${connected ? "done" : "now"}`}>
          <div className="gs-step-head">
            <span className="gs-badge">{connected ? "Done" : "Steps"}</span>
            <h3>Log in to Telegram</h3>
          </div>
          {connected ? (
            <p className="st-help">
              Telegram is connected as <strong>{state.connections.telegram.label}</strong>. Nothing more to do here.
            </p>
          ) : !state.telegramAvailable ? (
            <p className="st-help">Telegram is not switched on for this site yet. {state.telegramBlocked}</p>
          ) : (
            <ol className="gs-parts">
              <Part n="1" title="Type your phone number">
                <p>
                  On the <Link href="/connections#telegram">Connections page</Link>, in the Telegram card, type the number your Telegram account uses, <strong>with its country code</strong>, and click{" "}
                  <strong>Send me the code</strong>.
                </p>
                <Sketch
                  url="Command Center › Connections"
                  caption="Your number with its country code, then Send me the code."
                  parts={[
                    { t: "title", text: "Telegram" },
                    { t: "field", label: "Phone number", value: "+44 7700 900123", hi: true },
                    { t: "buttons", items: [{ label: "Send me the code", primary: true, hi: true }] },
                  ]}
                />
              </Part>
              <Part n="2" title="Type the code Telegram sends">
                <p>
                  Telegram sends a login code as a message from <strong>Telegram</strong> itself, inside the Telegram app (sometimes by text message instead). Type it in the card and click{" "}
                  <strong>Continue</strong>. Never send this code to anyone, not even here in a chat.
                </p>
                <Sketch
                  url="Telegram app"
                  caption="The code arrives in Telegram, from Telegram. Type it in the card."
                  parts={[{ t: "message", from: "Telegram", text: "Login code: 12345. Do not give this code to anyone, even if they say they are from Telegram!", hi: true }]}
                />
              </Part>
              <Part n="3" title="Your Telegram password, if you have one">
                <p>
                  If your account has two-step verification, the card asks for your Telegram password next: type it and click <strong>Connect Telegram</strong>. It is used once, to log in, and never kept.
                </p>
              </Part>
              <Part n="4" title="Done">
                <p>
                  Telegram shows a notice about a new login from <strong>SPM Command Center</strong>: that is this. Your chats start coming in within a minute.
                </p>
              </Part>
            </ol>
          )}
        </li>

        <li className={`panel gs-step ${connected ? "now" : "later"}`}>
          <div className="gs-step-head">
            <span className="gs-badge">Then</span>
            <h3>Pick what matters</h3>
          </div>
          <p className="st-help">
            Only the chats you tick come in. In <Link href="/settings#telegram">Settings, Telegram chats</Link>, tick the people, groups and channels you want on the dashboard: nothing else is
            read. Then, in <Link href="/settings#important">Settings, Important</Link>, tick the ones whose messages go to the top of your inbox.
          </p>
        </li>
      </ol>

      <div className="panel gs-help">
        <h3>Good to know</h3>
        <ul>
          <li>
            <strong>No code arrives:</strong> look in the Telegram app on every device you are logged in on, for a message from Telegram. Check the country code of the number, and wait a minute before
            asking again: Telegram slows down repeated requests.
          </li>
          <li>
            <strong>To disconnect:</strong> Disconnect in the Telegram card here. You can also end it from Telegram: Settings, Devices, SPM Command Center, Terminate.
          </li>
          <li>
            <strong>Something else:</strong> send Shruti a screenshot in #spm-development.
          </li>
        </ul>
      </div>
    </section>
  );
}
