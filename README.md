# SPM Command Center

One place for Jeremy's messages, calls and tasks. Phase 1 connects Slack, Telegram and Fathom call recordings, sorts what comes in, and lets him reply or delegate from one page.

Nothing is connected yet. The app runs on sample data until the access keys arrive.

## Where things are

| Folder | What it holds |
| --- | --- |
| [docs/](docs/) | The Phase 1 plan, the research behind it, and Jeremy's prototype |
| [ui/](ui/) | The dashboard: a Next.js app with the Phase 1 screens and the logic behind them |

## Run it

```bash
cd ui
npm install
npm run dev        # http://localhost:3000
```

Checks: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`.

## What works today

Every Phase 1 tab works on sample data, saved in the browser:

- **Today**: focus for the day and week, monthly pace, quick links, messages needing a reply, tasks due today.
- **Departments**: tasks per department, who is responsible, on track or overdue.
- **Inbox**: Slack and Telegram conversations by priority. Reply, set priority, make a task, delegate, mark done.
- **Meetings**: recorded calls with notes, decisions, transcript and the tasks from each call.
- **Tasks**: suggested tasks to add or dismiss, your own tasks, delegate with a note, take back.
- **Targets**: monthly targets with pace and projection, a daily log, and editable target numbers.
- **Settings**: connections, timers, team and responsibilities, and the two rule lists.

Replies and delegation messages are queued, not sent, because Slack and Telegram are not connected. Payments, the calendar and the Personal side are hidden until Phase 2.

## How the code is laid out

| Path | What it is |
| --- | --- |
| `ui/src/core/` | Plain logic with no UI and no network: sorting rules, delegation matching, timers, target math, dates. Covered by tests. |
| `ui/src/data/sample.ts` | The sample data, taken from the prototype and cut down to Phase 1. |
| `ui/src/store/store.ts` | The app's data and every action on it. This is where the database goes in: `load`, `save` and the action bodies. |
| `ui/src/app/` | One folder per tab. |
| `ui/src/components/` | Pieces shared between tabs. |

## Ground rules

1. **Rules first, AI only where it is needed.** What is urgent, the Agency or Consulting label and who can take a task are plain rules. Only finding tasks in messages uses an AI model.
2. **One script per function, each with its own timer.** The list is in `ui/src/core/jobs.ts`. Each timer has a fastest allowed value so a check cannot hit a service's rate limit.
3. **Hide what does not work yet.**
4. **Separate from the tracker.** This repository shares nothing with `spm-hook-generator`.
5. **Built for one person, ready for more.** Every record will belong to one login.

## Next, as access arrives

| When we have | We build |
| --- | --- |
| The Supabase project | Database tables, login, and the store reading and writing the database in place of the browser |
| Jeremy's Slack token | `slack-pull`, sending replies and delegation messages, `slack-directory-sync` |
| The Fathom API key | `fathom-pull`: calls, notes, transcript, action items |
| An AI API key | `task-suggest`: tasks found in new messages |
| Telegram | The login screen and `telegram-pull`, tested first because it is the least certain part |
