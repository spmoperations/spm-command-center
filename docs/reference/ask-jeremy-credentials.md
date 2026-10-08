# What we need from Jeremy

Phase 1 needs two credentials from Jeremy: his Slack authorisation and his Fathom API key. Phase 2 adds Telegram, email and calendar, and WhatsApp if a workable route exists.

## Phase 1 credentials

| Credential | What it lets the dashboard do | Where Jeremy gets it | How it reaches us |
| --- | --- | --- | --- |
| Slack authorisation as Jeremy (a user token, starts with `xoxp-`) | Read the channels and DMs he can see and send replies as him | He installs the Slack app we prepare and clicks Allow. A workspace admin approves it if the workspace requires that | Through a Connect Slack button in the dashboard, so nobody copies the token |
| Slack app secrets: Client ID, Client Secret, Signing Secret | Make the Connect Slack button work | The app's Basic Information page, once the app is created from our manifest | Password manager |
| Fathom API key | Read his calls with summary and transcript | The settings area of his Fathom account | Password manager, or pasted into the dashboard's Connect Fathom field |

The Slack app has to be created inside SPM's own workspace, by Jeremy, a workspace admin, or Shruti if her Slack account may create apps. We send the manifest and the four clicks.

Permissions the Slack app will ask Jeremy for:

- Read message history in public channels, private channels, DMs and group DMs (`channels:history`, `groups:history`, `im:history`, `mpim:history`)
- List his conversations (`channels:read`, `groups:read`, `im:read`, `mpim:read`)
- Read team members and their emails, to tag the right person (`users:read`, `users:read.email`)
- Send messages as him (`chat:write`)
- Search messages, to catch mentions outside the chosen channels (`search:read`)

## Phase 2 credentials

| Credential | What it is | Where Jeremy gets it | How it reaches us |
| --- | --- | --- | --- |
| Telegram app id: `api_id` and `api_hash` | Identifies our connection to Telegram | my.telegram.org, under API development tools, logged in with his number. One per phone number | Password manager |
| Telegram login | A session on his own account, like adding a device | On our connect screen he types his phone number, the code Telegram sends him, and his two-step password if he has one | He types these himself. The code is never sent to anyone |
| Google authorisation for Gmail and Calendar | Read mail and calendar, send replies | He clicks Sign in with Google and allows | Through the button; nobody copies a token |
| Google OAuth client: Client ID and Client Secret | Make the Sign in with Google button work | A Google Cloud project inside SPM's Google Workspace, marked Internal, created by the Workspace admin | Password manager |
| WhatsApp | To be decided | Nothing to send yet | Works only if his number is on the WhatsApp Business app |
| KPI sources | One read-only key per tool | Depends on his KPI list | Password manager |

Why the Google client must sit inside SPM's own Workspace: reading Gmail is a restricted permission, and an app used only by people in the organisation is exempt from Google's verification. An app owned outside the organisation would have to pass Google's review first.

If his mailbox is Microsoft, not Google, this row changes; that route is not researched yet.

## Handing credentials over

- **Connect buttons first.** For Slack, Google and Telegram the secret goes from the service straight into our encrypted storage.
- **Copied keys go through a password manager.** The Fathom key and the app secrets are shared through SPM's password manager or a one-time secret link, not as text in Slack, WhatsApp or email.
- **Jeremy can switch each one off himself.** Remove the app in Slack, delete the key in Fathom, end the session under Devices in Telegram, remove the app's access in his Google account.
- **Stored encrypted.** The dashboard never shows a token again after it is saved.

## Also needed, not credentials

- [ ] Which Slack workspaces and channels to pull from, and whether his private DMs are included
- [ ] Team list: name, email, role, department, what each person can own
- [ ] KPI list: name, monthly target, where each number lives
- [ ] His OK that message and transcript text is stored in our database and sent to an AI model
- [ ] Email provider: Google or Microsoft
- [ ] WhatsApp: the personal app or the Business app
- [ ] Whether he wants the Personal side (Health, Goals, Habits) at all
