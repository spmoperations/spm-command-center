# Research findings

Checked on 7 Oct 2026. Each section says what the official page states, what it means for the build, and what was not checked. Links are the pages that were opened.

## Slack

**What we need:** read Jeremy's DMs, mentions and chosen channels, and send replies as him.

- **Token kind: a user token (`xoxp-`).** "User tokens represent the same access a user has to a workspace: the channels, conversations, users, reactions, and so on that they can see." "Write actions with user tokens are performed as if by the user themselves." ([tokens](https://docs.slack.dev/authentication/tokens))
- **Scopes to read history with a user token:** `channels:history`, `groups:history`, `im:history`, `mpim:history`. ([conversations.history](https://docs.slack.dev/reference/methods/conversations.history))
- **Scope to post as him:** `chat:write`. A message sent with a user token carries the token owner's name and icon. ([chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage))
- **Limits:** `conversations.history` is Tier 3, 50+ requests a minute. Tiers: 1 = 1+/min, 2 = 20+/min, 3 = 50+/min, 4 = 100+/min. Posting: 1 message a second per channel. Over the limit: HTTP 429 with a `Retry-After` header in seconds. ([rate limits](https://docs.slack.dev/apis/web-api/rate-limits))
- **Bookmark:** `oldest` returns only messages after a timestamp; `limit` goes up to 999 (default 100); `cursor` pages.
- **The app must be internal.** Since 29 May 2025 an app distributed outside the Marketplace is held to 1 `conversations.history` request a minute and 15 messages per request. Apps built inside the customer's own workspace keep the normal limits.
- **Creating the app:** Create an app, choose "from a manifest", paste the manifest, pick the workspace, Next, Create. ([app manifests](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests))

**Not checked:** the rate tier of `search.messages`; whether a manifest can declare user scopes (the manifest reference page was not opened); whether SPM's workspace requires admin approval for apps; whether Jeremy is a workspace admin.

## Fathom

- **Auth:** an API key generated in the settings area of the Fathom website. ([API overview](https://developers.fathom.ai/api-overview))
- **Limits:** 60 calls per 60 seconds. Transcripts, summaries and meeting lists that include them: 30 per 60 seconds, which Fathom may lower to 5 per 60 seconds under load. Recording downloads: 30 per 60 seconds.
- **Endpoints listed in the docs index:** list meetings, get summary, get transcript, list teams, list team members, create webhook, delete webhook. An OAuth guide also exists.
- **From the tracker's working Fathom integration:** a key belongs to one user and sees only that user's recordings and those shared with them; a webhook can deliver the transcript and summary when a call ends.

**Not checked:** whether the meetings list returns Fathom's action items; whether all of Jeremy's calls are recorded under his own account.

## Telegram

- **A bot cannot read his personal chats.** Reading them needs a login as his own account through Telegram's user API. This is well known, but no official page was opened for it.
- **App id:** `api_id` and `api_hash` come from my.telegram.org, under API development tools. "For the moment each number can only have one api_id connected to it." ([obtaining an api_id](https://core.telegram.org/api/obtaining_api_id))
- **Risk stated by Telegram:** "all accounts that log in using unofficial Telegram API clients are automatically put under observation". Flooding or spamming gets an account "banned forever".
- **Limits:** no published numbers. A 420 `FLOOD_WAIT_X` error means wait X seconds. ([errors](https://core.telegram.org/api/errors))

**Not proven:** logging in as a user account from short-lived server functions. If it fails, Telegram needs one small always-on worker.

## Gmail and Google

- **Quota:** 1,200,000 units a minute per project; 6,000 units a minute per user. Costs: `history.list` 2, `messages.list` 5, `messages.get` 20, `threads.get` 40, `messages.send` 100. ([usage limits](https://developers.google.com/workspace/gmail/api/reference/quota))
- **Scopes:** `gmail.readonly`, `gmail.modify`, `gmail.compose` and `gmail.metadata` are Restricted; `gmail.send` is Sensitive. Restricted scopes need Google's restricted-scope verification, and a security assessment when the data is stored on servers. ([Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes))
- **The exemption:** an Internal app, "only used by people in your Google Workspace or Cloud Identity organization", needs no verification and has no 100-user cap. An app in testing mode shows the unverified-app screen and is capped at 100 users. ([Google](https://support.google.com/cloud/answer/13464323))

**Meaning:** the OAuth client must be created inside SPM's Google Workspace and marked Internal.

**Not checked:** Calendar scopes; the Microsoft route, if his mailbox is not Google.

## WhatsApp

- Meta lets a number be used on the app and the Cloud API together only for **WhatsApp Business app** numbers. ([Meta](https://developers.facebook.com/docs/whatsapp/embedded-signup/custom-flows/onboarding-business-app-users))
- Limits Meta lists for that setup: "Group chats will not be synchronized"; disappearing and view-once messages are turned off for 1:1 chats; broadcast lists are disabled; message history must be synced within 24 hours.
- A personal WhatsApp number has no official route. Provider pages say so directly; Meta's page says it by naming Business app numbers as the eligible ones.

## Hosting timers (Vercel)

- **Cron jobs:** 100 per project on every plan. Hobby: once a day at most, timing within the hour. Pro: once a minute. ([cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing))
- **Function run time:** Hobby 300 seconds. Pro 300 seconds by default, 800 seconds maximum. ([function limits](https://vercel.com/docs/functions/limitations))
- **Schedules are written in `vercel.json`,** so they change only with a new deployment. That is why the timers live in a jobs table, read by one ticker.

## Supabase

- **Cron:** built on `pg_cron`. Runs "from every second to once a year". A job can run SQL, a database function, or make an HTTP request such as calling an Edge Function. ([Cron](https://supabase.com/docs/guides/cron))
- **SQL:** `cron.schedule(name, schedule, command)`, `cron.alter_job(job_id, schedule)`, `cron.unschedule(name)`; `net.http_post(url, headers, body)` for the HTTP call. ([Cron quickstart](https://supabase.com/docs/guides/cron/quickstart))
- **Roles:** Owner, Administrator, Developer, Read-only. Only Owner and Administrator create projects. Developer reads the API keys and runs SQL but cannot change database settings. A role for a single project needs the Team or Enterprise plan. ([access control](https://supabase.com/docs/guides/platform/access-control))
- **Plans:** two free projects per account; projects in a Pro organisation are not paused. ([billing](https://supabase.com/docs/guides/platform/billing-on-supabase))

## What the tracker (spm-hook-generator) already does

Read only; nothing in that repository was changed.

- **Slack:** a bot token that only posts. It never reads conversations, so it cannot serve as Jeremy's connection.
- **Telegram:** one bot that only sends the daily update.
- **Fathom:** a key and a webhook per client, feeding call reviews.
- **AI:** OpenAI and Anthropic keys held in the hosting environment.
- **Timers:** fixed schedules in `vercel.json`.

Nothing is shared with the new project. The Fathom client and the webhook signature check are patterns worth copying.
