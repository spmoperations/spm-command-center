# SPM Command Center

One place for Jeremy's messages, calls and tasks. Phase 1 connects Slack, Telegram and Fathom call recordings, sorts what comes in, suggests tasks, and lets him reply or delegate from one page. A switch in the header shows the Professional or the Personal side.

Slack and Fathom are live: the app reads real messages and calls into its own database. Telegram is not connected yet, and sending is switched off.

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

There is one fixed login for now: `LOGIN_EMAIL` and `LOGIN_PASSWORD` in `ui/.env.local`. They are not in the code, because this repository is public.

- A visitor who is not signed in is sent to `/login` by `ui/src/proxy.ts`. Every API route checks the session again itself.
- Signing in sets a signed cookie that lasts 7 days. Scripts cannot read it, and it is sent only over https once the site is on https.
- Eight wrong passwords in a row lock sign-in for ten minutes.
- To change the password, edit `LOGIN_PASSWORD` and restart. Changing `SECRETS_KEY` signs everyone out.

A login per person (Supabase sign-in) replaces this when more people use the dashboard.

## Professional and Personal

The switch next to the title shows one side at a time. Each conversation, task, suggested task, focus item and quick link belongs to one side; everything starts as Professional.

- **Move a chat:** change its "Professional" box to "Personal" in the inbox. It stays where you put it.
- **Move chats by rule:** Settings, "Personal or Professional". For example, direct messages from one person can always go to Personal.
- **Tasks:** the new-task form has the same choice. Personal tasks have no department or client and cannot be delegated.
- Departments, Meetings and Targets exist only on the Professional side. Payments, Goals and Health from the prototype are not built.

## How it works

1. **Connect** Slack and Fathom on the Connections tab. Each key is checked with its service and stored encrypted.
2. **Checks** read what is new. Each one is its own file in `ui/src/jobs/` with its own timer and bookmark.
3. **Rules** mark what is urgent, label each chat and find requests waiting for a reply. No AI is involved.
4. **Suggested tasks** appear on the Tasks tab: the owner's action items from calls, and messages that ask for something. Nothing becomes a task until Add task is clicked.
5. **You act** on the screens. Any work task or conversation can be assigned to someone on the team list or to anyone in Slack; a person picked from Slack is added to the team list the first time. The person is told in a direct message, or, when the task came from a channel or a group message, in that chat with a tag. A reply or a delegation goes into the outbox and is sent from the owner's own Slack account, once sending is switched on.

| Check | What it does | Uses AI |
| --- | --- | --- |
| `slack-directory-sync` | Reads the people and channel list | No |
| `slack-pull` | Reads new messages: direct and group messages, ticked channels, and anywhere the owner is tagged | No |
| `fathom-pull` | Reads new calls with notes, transcript and action items. The owner's action items become suggested tasks | No |
| `inbox-rules` | Applies the sorting rules after each message check | No |
| `request-finder` | After each message check, finds messages that ask the owner for something (a question, "can you", "please", "following up" and the like) and are still unanswered, and suggests a "Reply to" task. Drops the suggestion once he replies | No |
| `task-suggest` | Finds other tasks in new messages from conversations the rules rated worth reading | Yes |
| `outbox-retry` | Sends what is waiting in the outbox | No |
| `telegram-pull` | Not built yet | No |

Run one by hand with `npm run job -- slack-pull` (with the local database, stop the app first: it allows one process at a time), or press Run now in Settings, Timers.

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
5. **Built for one person, ready for more.** Every row belongs to one owner.

## Not done yet

| What | What it needs |
| --- | --- |
| Finding tasks in messages with AI | Credit on the Claude account. The check is built and tested, and fails today with "no credit". Requests waiting for a reply are found without it. |
| Sending replies and delegations | A decision to switch `SENDING_ENABLED` on. The sending code is tested against a fake Slack only. |
| Telegram | Telegram app keys from my.telegram.org, then the login screen and `telegram-pull` |
| A login per person | Supabase sign-in, in place of the one fixed login. The hosted database is in use already (see Database). |
| Personal: Payments, Goals, Health | The tabs from the prototype's Personal side that are not built. |
| Hosting | A host, plus a scheduled request to `POST /api/jobs` with `{"id":"tick"}` once a minute. That request needs its own key first: today the route accepts only a signed-in browser. |
