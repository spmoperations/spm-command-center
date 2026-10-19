# Connecting Google (Gmail and Calendar)

What it does:
- **Inbox:** every email that arrives in a connected Gmail inbox, from the moment the account
  is connected, comes into the Command Center inbox, one row per thread.
- **Calendar tab:** shows the connected Google Calendars week by week, like Google Calendar,
  from last week to three weeks ahead.
- **Meetings tab:** starts with the meetings for today and tomorrow, each with a Join link.

More than one Google account can be connected. It only reads: nothing is sent, archived,
marked as read or changed in Google.

For the person connecting, it is one button: **Connections → Connect Google → pick the
account → Allow.** A second account: **Add another Google account**, the same way.

Status: built and tested against a pretend Google, on the local branch `google-connection`.
Not pushed. Not on the live site.

## 1. Your local test: the Google Cloud setup

Do this signed in to Google with your Hermon account, `shruti@hermon.io`: it is the one you
will connect, and hermon.io runs on Google Workspace. Each link opens the right page. Check that the project picker at the top shows the
project you made in step 1.

1. **Make a project.** https://console.cloud.google.com/projectcreate
   Name it `SPM Command Center (dev)`, keep the organisation, click **Create**.
2. **Turn on Gmail.** https://console.cloud.google.com/apis/library/gmail.googleapis.com
   Click **Enable**.
3. **Turn on Calendar.** https://console.cloud.google.com/apis/library/calendar-json.googleapis.com
   Click **Enable**.
4. **Set up the sign-in screen.** https://console.cloud.google.com/auth/overview
   - Click **Get started**.
   - App name `SPM Command Center (dev)`, and your email as the support email.
   - Audience **Internal**.
   - Your email as the contact. Agree, then **Create**.
5. **Say what it may read.** https://console.cloud.google.com/auth/scopes
   - Click **Add or remove scopes**.
   - Under **Manually add scopes**, paste these two lines:
     ```
     https://www.googleapis.com/auth/gmail.readonly
     https://www.googleapis.com/auth/calendar.events.readonly
     ```
   - Click **Add to table**, then **Update**, then **Save**.
6. **Make the client.** https://console.cloud.google.com/auth/clients/create
   - Application type **Web application**, name `Local`.
   - Under **Authorized redirect URIs**, add both of these, then **Create**:
     ```
     http://127.0.0.1:3100/api/google/callback
     http://localhost:3100/api/google/callback
     ```
   - Copy the **Client ID** and the **Client secret** straight away: newer projects show the
     secret in full only this once.
7. **Give them to the app.** Open `ui/.env.local`. The two lines are already at the bottom.
   Paste after the `=` signs. Don't paste them into a chat.
   ```
   GOOGLE_CLIENT_ID=…apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=…
   ```

## 2. Connect and try it

1. In a terminal:
   ```
   cd "/Users/shruti/Desktop/work/Jermey's Dashboard/ui"
   git switch google-connection
   npm run dev:local -- -p 3100
   ```
   Port 3100 is the one the redirect URIs above name; Google refuses any other. (Port 3000 is
   often taken by another app on this Mac, and Next would then quietly pick a different one.)
   Only `dev:local`. Plain `npm run dev` uses the hosted database: Google refuses to start
   there, but this branch's database changes would still be applied to it.
2. Open http://127.0.0.1:3100/connections and click **Connect Google**.
3. Pick your account and click **Allow**, leaving both boxes ticked. You come back to
   Connections with the account listed.
4. Open http://127.0.0.1:3100/calendar: last week to three weeks ahead. Click an event for
   who is in it and the Join link.
5. Emails start from the moment you connected. Send yourself an email, then:
   - In http://127.0.0.1:3100/settings, under Timers, click **Run now** beside "Gets new emails
     from Gmail". **Sync now** runs every check instead.
   - The email appears in http://127.0.0.1:3100/inbox.

   On your machine checks run only when clicked, because `.env.local` has `TICKER=off`. On
   the live site they run by themselves: emails every 15 minutes, the calendar every 30.
6. **A second account:** on the Google card, click **Add another Google account**.
   - An **Internal** project only accepts accounts of its own Workspace, so a second
     hermon.io account works straight away.
   - To try an account from another domain (a gmail.com one, for example), go to
     https://console.cloud.google.com/auth/audience, click **Make external**, keep it in
     **Testing**, and add both accounts under **Test users**. Logins in Testing last 7
     days, which is fine for a test.

If Google says your admin has blocked the app: in the Workspace Admin console
(https://admin.google.com/ac/owl), open API controls and turn on **Trust internal,
domain-owned apps**.

To start over: on the Google card, choose **Disconnect** or **Disconnect and remove its
emails** beside the account. Both also end the login on Google's side.

## What comes in

- **Emails:** everything that arrives in the inbox after the account was connected. Nothing
  from before.
  - Each run carries on from where the last one stopped in the mailbox (Gmail's history), so
    nothing is missed however much arrives in between.
  - A run opens at most 50 threads (`GMAIL_MAX_THREADS`); the rest come in the next run.
  - After more than about a week switched off, Gmail no longer has that history, and the
    check looks by date from its last run instead.

  How it sorts:
  - An email written to the account by a person counts as a direct message for the
    sorting rules: **Medium** by default.
  - Newsletters, no-reply mail, Gmail's Promotions, Social, Updates and Forums tabs, and
    emails the account is only copied on come in as **Low**.
  - The subject is the row's title, and the quoted history under a reply is cut off.
  - With more than one account, each row says which account it came to.
- **Calendar:** the main calendar of each connected account, from the start of last week to
  three weeks ahead.
  - Shown as Google Calendar shows them: meetings, all-day events, focus time (striped) and
    out of office (grey).
  - A meeting not answered yet has a dashed outline.
  - Left out: declined and cancelled events, and birthdays.
  - A meeting on two connected calendars shows once. With more than one account, each has
    its own colour and can be hidden.
  - Times show in the timezone of whoever is looking, with the zone named.
- **Not built yet:**
  - Replying to an email from the dashboard. It needs one more Google permission
    (`gmail.send`); for now an email has **Open in Gmail** in place of the reply box.
  - Calendars other than each account's main one.

## 3. The live site, for Jeremy

Reading Gmail is a "restricted" permission at Google. The project's audience decides what
Jeremy sees:

| Audience | What he sees | Login lasts |
| --- | --- | --- |
| **Internal** (project inside SPM's Google Workspace) | Google's normal Allow page | Until removed |
| External, "In production", not verified | A "Google hasn't verified this app" warning first | Until removed |
| External, "Testing" | The same warning | 7 days |

socialprofitmedia.co runs its email on Google Workspace, so **Internal** works.

What we need from SPM, in one ask:

1. **A Google Workspace account in SPM's domain for Shruti** (for example
   `shruti@socialprofitmedia.co`). Or SPM's Google admin creates an empty Google Cloud project
   called `SPM Command Center` and adds Shruti as **Owner**. Either way, the project belongs
   to SPM.
2. **Confirmation that Jeremy's email is that Workspace account**, and that the admin allows
   internal apps (the setting above).

Then Shruti does section 1 again in SPM's project, with two differences:
- The redirect URI is `https://spm-command-center.vercel.app/api/google/callback`.
- The keys go on Vercel, not in `.env.local`:
  - `GOOGLE_CLIENT_ID`
  - `GOOGLE_CLIENT_SECRET`
  - `GOOGLE_HOSTED=true`

  Set them for Production, then merge this branch and redeploy, once it's agreed.

**Jeremy's part:** Connections → **Connect Google** → his SPM account → **Allow**. Any other
SPM account of his: **Add another Google account**.

If no project can be made in SPM's Workspace: use one External project set to "In
production", and tell Jeremy to expect the "Google hasn't verified this app" screen. He
clicks Advanced, then "Go to SPM Command Center". Google allows this for up to 100 people
over the project's life.

## Safety

- Each account's login (a refresh token) is stored encrypted, like the Slack token.
  Disconnecting revokes it at Google.
- With the hosted database, Google stays off unless `GOOGLE_HOSTED=true` is set on the server.
  That switch belongs on Vercel only, so a developer's own Gmail can't end up in the client's
  database.
