# Prompts

Every instruction the Command Center gives an AI model is in this folder, one file per prompt. Nothing is sent to a model from anywhere else.

| Prompt | File | Used by | Runs |
| --- | --- | --- | --- |
| Find tasks in messages | [task-finder.ts](task-finder.ts) | The check "Finds other tasks in your messages" (`src/jobs/task-suggest.ts`) | Switched off for now |
| Is it a real task? | [task-check.ts](task-check.ts) | The check "Checks each flagged message with AI" (`src/jobs/task-check.ts`) | On a timer, capped each day |
| What a task from a call is about | [call-context.ts](call-context.ts) | The check "Writes what each task from a call is about, with AI" (`src/jobs/call-context.ts`) | Right after each Fathom check, for new calls only: one request per call, at most 4 a run and 20 a day |

Sorting the inbox, finding messages that ask for something, and which part of a call an action item came from all work by plain rules, with no AI.

## What is in a prompt file

| Part | What it is |
| --- | --- |
| `SYSTEM` | Who the model is and how it should judge. Sent with every request. |
| `message(...)` | The request itself, built from the data: the person's name, today's date, tasks already known, and the conversations to read. |
| `FIELDS` | What each part of the answer means. The model must answer in a fixed shape, and these notes go with it. |

## Changing a prompt

Edit the wording in the file and restart the app. The code that calls the model is in `src/server/ai.ts` and does not need to change. The model is set by `ANTHROPIC_MODEL` in `.env.local` (default `claude-haiku-4-5`).

`npm test` checks that the request still carries what the model needs. It does not judge the wording, so read a few real results after a change.

## What the model is and is not given

- Only conversations the rules already rated worth reading: direct messages, tags, and anything above Low priority.
- At most the last 6 messages of each, each cut to 600 characters, and at most 25 conversations a run (`AI_MAX_CONVERSATIONS`).
- Anything that looks like an access key is removed first.
- The prompt tells the model that conversation text is data, not instructions.
- Whatever comes back is checked before it is stored: a task must point at a conversation that was sent, and nothing becomes a task until it is accepted on the Tasks tab.
