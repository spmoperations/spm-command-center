# SPM Command Center

One place for Jeremy's messages, calls and tasks. It connects Slack and Fathom call recordings, sorts what comes in, suggests tasks, and lets him reply or assign from one page.

Slack and Fathom are live: the app reads real messages and calls into its own database. The screens show only what works today; see "Switched off for now" below for the rest. Replies and assignments are sent from the owner's own Slack account when `SENDING_ENABLED=true`; without it they wait in the outbox.

## Where things are

| Folder | What it holds |
| --- | --- |
| [docs/](docs/) | The Phase 1 plan, the research behind it, and Jeremy's prototype |
| [ui/](ui/) | The app: screens, API, database and the checks that read Slack and Fathom |

## Run it

```bash
cd ui
npm install
cp .env.example .env.local     # then fill it in
npm run dev -- -p 3210         # http://127.0.0.1:3210
```

The server listens on this machine only.

Checks: `npm test`, `npm run test:hosted`, `npm run typecheck`, `npm run lint`, `npm run build`.

## Sign-in

The owner's login is `LOGIN_EMAIL` and `LOGIN_PASSWORD` in `ui/.env.local`. They are not in the code, because this repository is public.

- A visitor who is not signed in is sent to `/login` by `ui/src/proxy.ts`. Every API route checks the session again itself.
- Signing in sets a signed cookie that lasts 7 days. Scripts cannot read it, and it is sent only over https once the site is on https.
- Eight wrong passwords in a row lock sign-in for ten minutes.
- To change the owner's password, edit `LOGIN_PASSWORD` and restart. Changing `SECRETS_KEY` signs everyone out.

### Team logins

The owner can give someone on the team a Command Center of their own: **Settings → Team logins**, with their name, email and a password (at least 10 characters; **Make one** writes one). The dashboard does not send it; the owner does.

- A team member signs in at the same address, connects their own Slack, Google, Telegram and Fathom on their Connections page, and sees only their own messages, emails, calls and tasks. The owner's data, connections and login are not shown to them and do not change.
- Every query is limited to the signed-in person (`owner_id`), and a test fails if one is not. Two people in the same Slack chat or on the same call each have their own row under the same id.
- **New password** ends that person's sessions. **Turn off** stops their sign-in and their checks, and keeps their data. **Remove** deletes their login and everything of theirs.
- Only the owner sees Team logins. The scheduled checks run for the owner first, then for each team member who can sign in (`ui/src/server/team.ts`).

### App keys

The keys of the apps the dashboard connects through are kept in the database, encrypted, for each person: Google's OAuth client (Client ID and secret), Telegram's app (api_id and api_hash) and the AI key. Anyone saves their own under **Connections → App keys**; Google's and the AI's are checked with the service before they are kept. Someone with none of their own uses the owner's, the team's keys.

- **A connection keeps the keys it was made with.** Saving new keys, for yourself or as the owner, changes only what new connections use; every account connected before goes on working with its own (`ui/src/server/app-keys.ts`).
- **From the settings, once.** On first start, keys in the settings (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `ANTHROPIC_API_KEY`, `ANTHROPIC_WORKSPACE_ID`) are copied in as the owner's keys: into a local database, or into the hosted one from the live site only (Vercel, or `GOOGLE_HOSTED`/`TELEGRAM_HOSTED` set). Accounts connected before were made with exactly these. After that the settings can be removed.
- **What stays in the settings:** what the whole site needs: `DATABASE_URL`, `SECRETS_KEY` (it unlocks every stored key and login: never change it), `LOGIN_EMAIL` and `LOGIN_PASSWORD`, `CRON_SECRET`, `SENDING_ENABLED`, `GOOGLE_HOSTED`, `TELEGRAM_HOSTED` and the limits.

## Switched off for now

These are built or planned but left off the screens for now. Each has one line to change.

| What | Why it is off | To bring it back |
| --- | --- | --- |
| The Personal side | Asked to be parked for now | `PERSONAL_SIDE = true` in `ui/src/core/config.ts` |
| Departments (the tab, and the department on tasks and team members) | Nothing yet says which department a task or person belongs to | `DEPARTMENTS = true` in `ui/src/core/config.ts` |
| Targets (the tab, and the month's pace on Today) | The numbers are the prototype's examples; nothing fills them in yet | `TARGETS = true` in `ui/src/core/config.ts` |
| Finding tasks with AI | The Claude account has no credit, so every run fails | `live: true` on `task-suggest` in `ui/src/core/jobs.ts` |
| Telegram | It needs its two app keys (api_id and api_hash, from my.telegram.org) under Connections → App keys, or in the settings for the first start. With the hosted database it also needs `TELEGRAM_HOSTED=true`, which only the live site sets, so a developer's own account can never end up in the hosted database | Set the keys (and on the live site the switch). The Connections tab then shows the Telegram login. On your own machine use `npm run dev:local`, which keeps the data on your computer |

While the Personal side is off, everything shows as Professional, including anything that was moved to Personal earlier.

## Professional and Personal

Off for now (see above). When it is on, the switch next to the title shows one side at a time. Each conversation, task, suggested task, focus item and quick link belongs to one side; everything starts as Professional.

- **Move a chat:** change its "Professional" box to "Personal" in the inbox. It stays where you put it.
- **Move chats by rule:** Settings, "Personal or Professional". For example, direct messages from one person can always go to Personal.
- **Tasks:** the new-task form has the same choice. Personal tasks have no department or client and cannot be delegated.
- Departments, Meetings and Targets exist only on the Professional side. Payments, Goals and Health from the prototype are not built.

## How it works

1. **Connect** Slack and Fathom on the Connections tab. Each key is checked with its service and stored encrypted. Telegram is a phone number and a code; Google is one button (see `docs/google-connection.md`).
2. **Checks** read what is new. Each one is its own file in `ui/src/jobs/` with its own timer and bookmark.
3. **Rules** mark what is urgent, label each chat and find requests waiting for a reply. No AI is involved.
   Slack threads are kept whole: when the owner is tagged in a reply, the message that started the thread and the other replies come in with it, and later replies to that thread keep coming in. A reply written in the dashboard goes into the thread it answers.
   In a channel, each thread the owner is tagged in is a row of its own in the inbox, and a single message that tags them counts as a thread of one. Two threads in one channel are two rows, each answered, cleared and turned into a task by itself. What is not addressed to them, in a channel they follow, stays in the channel's own row. Direct and group messages stay one row per chat. 
   Cleared conversations are kept in a list behind the Restore link in the inbox: each can be opened to read, and put back one at a time. Opening a conversation asks Slack once which of its other messages have replies, and reads those threads too.
   Each person's Slack profile picture shows beside their messages. Only the picture's address is stored; the picture itself stays with Slack.
   Reactions show under each message, with the owner's own picked out, and are brought up to date when a conversation is opened. Pictures sent in Slack show too once the Slack app has the `files:read` permission: the dashboard fetches each one with the owner's token and hands it only to a signed-in person. Until then a picture is named, with a link that opens it in Slack. Videos are never fetched.
   Telegram works the same way: one-to-one chats, and a group when the owner is tagged or replied to. Telegram hands a picture over only to the logged-in account, so its pictures, stickers and profile pictures are kept in the `media` table at a size for the screen. Telegram's own account, which sends login codes, is never read.
   More than one Google account can be connected. Every email that arrives in a connected inbox after the account was connected comes in as one row per thread: each run carries on from where the last stopped in Gmail's history, so nothing is missed. The row shows the subject; quoted history under a reply is left out. An email written to the account by a person counts as a direct message for the sorting rules; newsletters, no-reply mail, Gmail's other tabs and emails the account is only copied on sort low. Google is connected for reading only: an email row has an Open in Gmail link in place of the reply box.
   The Calendar tab shows the connected Google Calendars week by week, from last week to three weeks ahead, as Google Calendar does: overlapping meetings side by side, all-day events on top, focus time and out of office marked, a line at the current time, and each event's people and Join link a click away. The Meetings tab starts with today's meetings.
   The Telegram login is three requests (phone number, code, password if the account has one). Nothing about a login in progress is kept on the server: what the next step needs goes back to the browser sealed in a cookie, so the steps work when a host answers them from different servers. The finished login is stored encrypted, like the Slack token.
4. **Suggested tasks** appear on the Tasks tab: the owner's action items from calls, and messages that ask for something. Nothing becomes a task until Add task is clicked.
5. **You act** on the screens. Any work task or conversation can be assigned to someone on the team list or to anyone in Slack; a person picked from Slack is added to the team list the first time. The person is told in a direct message, or, when the task came from a channel or a group message, in that chat with a tag. A reply or a delegation goes into the outbox and is sent from the owner's own Slack account, once sending is switched on. A task is made first, with an optional description, and assigned afterwards from its row. The Slack message says what the task is, when it is due, its priority and project, then the note; the task's description follows as a reply in that message's thread. The assign form shows both before anything is sent. The Tasks tab is one table, highest priority first, with the priority as a coloured tag in front of each task. A task that is done leaves the table and is found under Status: Done. The description shows when a task is opened.

| Check | What it does | Uses AI |
| --- | --- | --- |
| `slack-directory-sync` | Reads the people and channel list | No |
| `slack-pull` | Reads new messages: direct and group messages, ticked channels, and anywhere the owner is tagged | No |
| `fathom-pull` | Reads new calls with notes, transcript and action items. The owner's action items become suggested tasks | No |
| `inbox-rules` | Applies the sorting rules after each message check, and clears the Slack and Telegram conversations whose latest message is the owner's (a new message from someone else brings one back; one restored by hand stays). Then clears any conversation with nothing new for 3 days (`INBOX_DAYS` in `ui/src/core/config.ts`): it moves to the cleared list, keeps its suggested task if a request is still waiting, and comes back when something new arrives or the owner restores it | No |
| `request-finder` | After each message check, finds messages that ask the owner for something (a question, "can you", "please", "following up" and the like) and are still unanswered, and suggests a "Reply to" task. Drops the suggestion once he replies | No |
| `task-suggest` | Finds other tasks in new messages from conversations the rules rated worth reading | Yes |
| `outbox-retry` | Sends what is waiting in the outbox | No |
| `telegram-pull` | Reads new Telegram messages with their pictures, stickers and reactions. Runs only on a server that may use Telegram (see What is switched off) | No |
| `gmail-pull` | Reads the emails that arrived in each connected Gmail inbox since the last run. Runs only on a server that may use Google, like Telegram | No |
| `calendar-pull` | Keeps a copy of each connected account's main Google Calendar, from the start of last week to three weeks ahead. Declined and cancelled events and birthdays are left out | No |

Run one by hand with `npm run job -- slack-pull` (with the local database, stop the app first: it allows one process at a time), or press Run now beside it in Settings. **Sync now** in Settings runs every working check at once.

## Automatic sync

The checks run by themselves. How depends on where the app runs.

| Where | What runs the timers |
| --- | --- |
| Your own machine or a server that stays up | A timer inside the server, once a minute. `TICKER=off` in `.env.local` stops it. |
| Vercel | Vercel Cron calls `GET /api/cron` (see `ui/vercel.json`), which runs whichever checks are due by the timers set in Settings. |

To deploy on Vercel:

1. Set the project's **Root Directory** to `ui`. `ui/vercel.json` tells Vercel this is a Next.js app, so the Framework Preset in the dashboard does not matter.
2. Add the variables from `.env.local` to the project, plus `CRON_SECRET` (any long random text). Vercel sends it with each cron call, and the route refuses anything else.
3. For `DATABASE_URL` use Supabase's **Transaction pooler** string (port 6543). The direct string needs IPv6, which Vercel does not have.
4. Leave `TICKER` out.

Vercel's **Hobby plan runs a cron job once a day at most**, and refuses to deploy a schedule that is more frequent. `ui/vercel.json` asks for every 5 minutes, which needs the Pro plan. On Hobby, change the schedule to once a day (for example `0 6 * * *`) and use Sync now in between, or have any other scheduler call `/api/cron` with the header `Authorization: Bearer <CRON_SECRET>`.

A check never runs twice at once, even if two servers start it together: the second one sees the first is running and steps aside.

## Safety switches

| Setting in `.env.local` | Effect |
| --- | --- |
| `SENDING_ENABLED=false` | Replies and delegation messages are saved and never sent. Nothing is written to Slack until this is `true`. |
| `TICKER=off` | Checks run only when Run now is pressed. Remove it to run them on their timers. |
| `SLACK_MAX_PAGES`, `SLACK_BACKFILL_DAYS`, `FATHOM_MAX_PAGES`, `FATHOM_BACKFILL_DAYS`, `AI_MAX_CONVERSATIONS` | How much one run may read. Kept small for development. |

Anything that looks like an access key is stripped from message text before it is sent to the AI.

## How the code is laid out

| Path | What it is |
| --- | --- |
| `ui/db/migrations/` | The database schema, as plain Postgres |
| `ui/src/core/` | Plain logic with no UI and no network: sorting rules, delegation matching, timers, target math, Slack text |
| `ui/src/server/` | Database access, every action a person can take, the Slack, Fathom and Claude clients, key encryption |
| `ui/src/jobs/` | One file per check, and the runner that times them |
| `ui/src/prompts/` | Every instruction given to an AI model, one file per prompt, with a README that lists them |
| `ui/src/app/api/` | The routes the screens call |
| `ui/src/app/`, `ui/src/components/` | One folder per tab, and the shared pieces |
| `ui/src/store/store.ts` | The browser's copy of the data: reads `/api/state`, sends each action to the server |

## Database

One schema, two homes. `ui/src/server/db.ts` picks between them, and nothing else in the app knows which is in use.

| `DATABASE_URL` in `.env.local` | Where the data lives |
| --- | --- |
| Empty | PGlite, a Postgres engine that runs inside the server and keeps its files in `ui/.data/`. One process at a time. |
| A Supabase connection string | The hosted Postgres. Use the **Session pooler** string from Supabase's Connect button, with the database password in place of `[YOUR-PASSWORD]`. |

To move to the hosted database: put the string in `ui/.env.local`, run `npm run db:check`, then restart the app. The check prints where it connected (never the password), applies any migration that has not run, and confirms every table is locked.

- **Migrations** in `ui/db/migrations/` are plain Postgres and run in name order on first connect. If `0001_init.sql` was run by hand in Supabase's SQL editor, the app notices the tables and carries on from `0002`.
- **Locked tables.** Supabase serves every table in the `public` schema through a public web API. `0002_row_level_security.sql` switches row level security on with no policies, so that API returns nothing. The app connects as the database owner and is not affected. Every new table needs the same line.
- **Data does not move** between the two homes. A new database starts empty: the connections are read again from `.env.local`, and Run now pulls the messages and calls again.
- **Both paths are tested.** `npm test` uses PGlite directly; `npm run test:hosted` runs the same tests through the hosted driver against a local stand-in server.

## Ground rules

1. **Rules first, AI only where it is needed.** Only finding tasks in messages uses a model.
2. **One script per function, each with its own timer.**
3. **Hide what does not work yet.**
4. **Separate from the tracker.** This repository shares nothing with `spm-hook-generator`.
5. **One Command Center per person.** Every row belongs to one person, and every query names whose rows it reads.

## Not done yet

| What | What it needs |
| --- | --- |
| Finding tasks in messages with AI | Credit on the Claude account. The check is built and tested, and fails today with "no credit". Requests waiting for a reply are found without it. |
| Sending, fully proven | Switched on with `SENDING_ENABLED=true`. A reply into a thread has been sent and read back from Slack. An assignment by direct message and a post to a channel have only run against a fake Slack so far. |
| Telegram on the live site, proven | Built and tested against a pretend Telegram. It needs the two app keys and `TELEGRAM_HOSTED=true` on the host, and has not yet been through a real login there. Pictures are kept in the database with no clean-up yet: about 100 KB each. |
| Pictures from Slack | The `files:read` permission on the Slack app (User Token Scopes), then a reinstall. A workspace's own custom emoji show by name; their pictures would need `emoji:read`. |
| Google, proven | Built and tested against a pretend Google, on branch `google-connection` only. It needs an OAuth client in Google Cloud (see `docs/google-connection.md`), a real login on a developer's machine, then `GOOGLE_HOSTED=true` and the client's keys on the host. |
| Replying to emails | The `gmail.send` permission, and a sender in the outbox. Until then an email opens in Gmail to be answered. |
| Team members on the live site | Built and tested on a developer's machine (see Team logins). Each person connects their own accounts; Slack asks each of them to install the app for themselves. A shared view of the whole team's tasks comes next. |
| Personal: Payments, Goals, Health | The tabs from the prototype's Personal side that are not built. |
| Hosting | Deploying it. The route for the host's scheduler and `vercel.json` are in place (see Automatic sync); it has been tested on this machine, not on Vercel. |
