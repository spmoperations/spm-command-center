"use client";

import Link from "next/link";
import { GOOGLE_PERMISSIONS } from "@/core/providers";
import { Copy, GuidePart as Part, Open, Sketch } from "@/components/Guide";
import { useApp } from "@/store/store";

// The guide for setting Google up, for the person whose Google account it is. Step 1 happens
// in Google Cloud, once, and ends with the two keys saved in the Google card on the Connections
// page. Step 2, connecting the account, then appears here by itself. Someone whose team has
// keys already skips Step 1.

const PERMISSIONS = GOOGLE_PERMISSIONS;
const SCOPES = PERMISSIONS.map(([scope]) => scope);

const PROJECT = "SPM Command Center";

/**
 * Every page in Google Cloud works on the project picked at the top. If another one is picked,
 * everything done on the page goes to that project instead, so each part checks it first.
 */
function ProjectCheck() {
  return (
    <div className="gs-check">
      <p>
        <strong>First, look at the top of the page:</strong> the project must say <strong>{PROJECT}</strong>. If it shows another name, or &quot;Select a project&quot;, click it and pick{" "}
        <strong>{PROJECT}</strong> in the list.
      </p>
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
            So your emails and calendar show in the Command Center, and you can answer emails and add events from here.{" "}
            {keysIn ? (
              <>
                Your team has set the Google side up already, so it is <strong>one step</strong>: connect your account.
              </>
            ) : (
              <>
                It takes two steps: <strong>Step 1</strong> in Google Cloud, once, about 10 minutes. Then <strong>Step 2</strong>, connecting your account, one click.
              </>
            )}
          </div>
        </div>
      </div>

      <ol className="gs-steps">
        <li className={`panel gs-step ${keysIn ? "done" : "now"}`}>
          <div className="gs-step-head">
            <span className="gs-badge">{keysIn ? "Done" : "Step 1"}</span>
            <h3>Set up Google Cloud, and save the two keys</h3>
          </div>
          {keysIn ? (
            <p className="st-help">Done for you: the team&apos;s keys are in place. Go on to Step 2.</p>
          ) : (
            <>
              <p className="st-help">
                Do this on a computer, signed in to Google with your <strong>SPM Google account</strong>: the one your socialprofitmedia.co email uses. If you use more than one Google account in this
                browser, check the picture at the top right of Google Cloud is the SPM one. Each button below opens the right page.
              </p>
              <ol className="gs-parts">
                <Part n="1" title="Make a project">
                  <p>
                    Open the page, type the name, and click <strong>Create</strong>. If it is your first time in Google Cloud, it first asks for your country and to agree to its terms: do that, then
                    carry on.
                  </p>
                  <p>
                    Google takes a few seconds. A notice then appears at the top right: click <strong>Select project</strong> in it. Now the top of the page should say <strong>{PROJECT}</strong>. If
                    it doesn&apos;t, click the project name there and pick it.
                  </p>
                  <Open href="https://console.cloud.google.com/projectcreate">Open New project</Open>
                  <Sketch
                    url="console.cloud.google.com/projectcreate"
                    caption="Project name: SPM Command Center. Leave the rest as it is, then click Create."
                    parts={[
                      { t: "title", text: "New Project" },
                      { t: "field", label: "Project name", value: "SPM Command Center", hi: true },
                      { t: "field", label: "Organization", value: "socialprofitmedia.co" },
                      { t: "buttons", items: [{ label: "Create", primary: true, hi: true }, { label: "Cancel" }] },
                    ]}
                  />
                  <Sketch
                    url="console.cloud.google.com"
                    caption="When the project is made: Select project in the notice, then check the name at the top."
                    parts={[
                      { t: "topbar", project: PROJECT, hi: true },
                      { t: "text", text: "Create Project: SPM Command Center" },
                      { t: "buttons", items: [{ label: "Select project", hi: true }] },
                    ]}
                  />
                </Part>
                <Part n="2" title="Turn on Gmail and Calendar">
                  <ProjectCheck />
                  <p>Open each page and click Enable. Do both. If a page says &quot;API Enabled&quot; or shows Manage instead of Enable, it is on already.</p>
                  <div className="gs-row">
                    <Open href="https://console.cloud.google.com/apis/library/gmail.googleapis.com">Open Gmail API</Open>
                    <Open href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com">Open Google Calendar API</Open>
                  </div>
                  <Sketch
                    url="console.cloud.google.com/apis/library/gmail.googleapis.com"
                    caption="Click Enable. Then the same on the Google Calendar API page."
                    parts={[
                      { t: "topbar", project: PROJECT, hi: true },
                      { t: "title", text: "Gmail API" },
                      { t: "text", text: "Google Enterprise API · View and manage Gmail data" },
                      { t: "buttons", items: [{ label: "Enable", primary: true, hi: true }, { label: "Try this API" }] },
                    ]}
                  />
                </Part>
                <Part n="3" title="Set up the sign-in screen">
                  <ProjectCheck />
                  <p>
                    Open the page and click <strong>Get started</strong>. It has four parts, one after the other:
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
                      { t: "topbar", project: PROJECT, hi: true },
                      { t: "title", text: "Project configuration" },
                      { t: "field", label: "1  App name", value: "SPM Command Center", hi: true },
                      { t: "field", label: "User support email", value: "you@socialprofitmedia.co", hi: true },
                      { t: "radio", options: ["Internal", "External"], picked: 0, hi: true },
                      { t: "field", label: "3  Contact email", value: "you@socialprofitmedia.co" },
                      { t: "check", label: "I agree to the Google API Services: User Data Policy", hi: true },
                      { t: "buttons", items: [{ label: "Create", primary: true, hi: true }, { label: "Cancel" }] },
                    ]}
                  />
                  <p className="st-help">
                    If the page shows <strong>OAuth Overview</strong> with a <strong>Create OAuth client</strong> button instead of Get started, this part is done already: go on to part 4. If Internal
                    can&apos;t be picked, the account isn&apos;t part of SPM&apos;s Google Workspace: ask Shruti before going on.
                  </p>
                </Part>
                <Part n="4" title="Say what it may do">
                  <ProjectCheck />
                  <p>
                    Open the page (it is <strong>Data Access</strong> in the menu on the left), and click <strong>Add or remove scopes</strong>. A panel opens on the right. At its bottom, under{" "}
                    <strong>Manually add scopes</strong>, paste these three lines and click <strong>Add to table</strong>, then <strong>Update</strong>. Back on the page, click <strong>Save</strong>{" "}
                    at the bottom.
                  </p>
                  <div className="gs-copy">
                    <pre>{SCOPES.join("\n")}</pre>
                    <Copy text={SCOPES.join("\n")} label="Copy the three lines" />
                  </div>
                  <ul className="gs-perms">
                    {PERMISSIONS.map(([scope, what]) => (
                      <li key={scope}>
                        <code>{scope.replace("https://www.googleapis.com/auth/", "")}</code> {what}
                      </li>
                    ))}
                  </ul>
                  <p className="st-help">
                    The dashboard only reads by itself. It sends an email, or adds, changes, deletes or answers an event, only when you do that in the dashboard. It never deletes an email. After{" "}
                    <strong>Update</strong>, Google lists them in two groups on the page, <strong>gmail.readonly</strong> under restricted scopes and the other two under sensitive scopes. That is
                    expected: click <strong>Save</strong>.
                  </p>
                  <Open href="https://console.cloud.google.com/auth/scopes">Open Data access</Open>
                  <Sketch
                    url="console.cloud.google.com/auth/scopes"
                    caption="Paste the three lines under Manually add scopes, click Add to table and Update. Then Save at the bottom of the page."
                    parts={[
                      { t: "topbar", project: PROJECT, hi: true },
                      { t: "title", text: "Update selected scopes" },
                      { t: "text", text: "Manually add scopes" },
                      { t: "code", lines: SCOPES, hi: true },
                      {
                        t: "buttons",
                        items: [
                          { label: "Add to table", hi: true },
                          { label: "Update", primary: true, hi: true },
                        ],
                      },
                    ]}
                  />
                </Part>
                <Part n="5" title="Make the client, with the return address">
                  <ProjectCheck />
                  <p>
                    Open the page. (The <strong>Create OAuth client</strong> button on the OAuth Overview page opens the same form.) For <strong>Application type</strong> pick{" "}
                    <strong>Web application</strong>: only then do the other boxes appear, including the one for the address. Name it <code>Command Center</code>. Leave{" "}
                    <strong>Authorized JavaScript origins</strong> empty. Under <strong>Authorized redirect URIs</strong>, click <strong>+ Add URI</strong> and paste this address, exactly. Then click{" "}
                    <strong>Create</strong>.
                  </p>
                  <div className="gs-copy">
                    <pre>{callback}</pre>
                    <Copy text={callback} label="Copy the address" />
                  </div>
                  <Open href="https://console.cloud.google.com/auth/clients/create">Open Create client</Open>
                  <p className="st-help">No box for Authorized redirect URIs? Application type is not set to Web application yet: pick it, and the box appears.</p>
                  <Sketch
                    url="console.cloud.google.com/auth/clients/create"
                    caption="Web application, a name, the address under Authorized redirect URIs, then Create."
                    parts={[
                      { t: "topbar", project: PROJECT, hi: true },
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
                <Part n="7" title="Save them in the Command Center">
                  <p>
                    On the <Link href="/connections#google">Connections page, in the Google card</Link>, paste the <strong>Client ID</strong> and the <strong>Client secret</strong> and click{" "}
                    <strong>Save the keys</strong>. They are checked with Google, then stored encrypted, and everyone on the team connects with them. That&apos;s the end of Step 1: Step 2 turns on
                    here by itself.
                  </p>
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
            <p className="st-help">This turns on as soon as the keys from Step 1 are saved.</p>
          ) : (
            <>
              <p className="st-help">
                Click the button, pick your <strong>socialprofitmedia.co</strong> account (Google lets only SPM&apos;s own accounts in), leave <strong>every box ticked</strong> and click{" "}
                <strong>Allow</strong>. You come back here with it connected. For another of your accounts, do the same again.
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
                  { t: "check", label: "View your email messages and settings", hi: true },
                  { t: "check", label: "Send email on your behalf", hi: true },
                  { t: "check", label: "View and edit events on all your calendars", hi: true },
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
            <strong>&quot;redirect_uri_mismatch&quot;:</strong> the address in part 5 is missing or different. Open the client under Clients and check it reads exactly <code>{callback}</code>. Google
            also says a new or changed client can take a few minutes to work: if it was made just now, wait five minutes and try again.
          </li>
          <li>
            <strong>Always open the dashboard at the same address</strong> (<code>{callback.replace("/api/google/callback", "")}</code>) when you connect: Google only sends you back to the address in
            part 5.
          </li>
          <li>
            <strong>Something else:</strong> send Shruti a screenshot in #spm-development.
          </li>
        </ul>
      </div>
    </section>
  );
}
