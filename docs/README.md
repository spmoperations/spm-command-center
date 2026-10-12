# Docs

The plan for Phase 1 and the material it was built from.

## Current

| File | What it is |
| --- | --- |
| [phase-1-plan.html](phase-1-plan.html) | The Phase 1 plan written for Jeremy and Jaap: what it does, what he will see, how often it checks, and what we need to start. Open it in a browser. |
| [prototype/spm-command-center-prototype.html](prototype/spm-command-center-prototype.html) | The prototype Jeremy shared on the 7 October 2026 call. The UI in `ui/` follows it. All of its data is sample data. |

## Reference

These were written on 7 October 2026, before three decisions changed. Where they disagree with the plan above, the plan is right.

| File | What it is |
| --- | --- |
| [reference/research-findings.md](reference/research-findings.md) | What the Slack, Fathom, Telegram, Gmail, WhatsApp, Vercel and Supabase docs say, with links. Still accurate. |
| [reference/build-plan.md](reference/build-plan.md) | The first build plan: jobs, timers, rate limits, phases. |
| [reference/ask-jeremy-credentials.md](reference/ask-jeremy-credentials.md) | The first list of credentials needed from Jeremy. |
| [reference/ask-jaap-repo-supabase.md](reference/ask-jaap-repo-supabase.md) | The first list of what is needed from Jaap. |

What changed after they were written:

1. **Telegram moved into Phase 1.** The reference files still list it under Phase 2.
2. **AI does one job only.** Priority and labels are set by rules, call tasks come from Fathom's own action items, and only finding tasks in messages uses a model. The reference files have AI setting priority and drafting replies.
3. **Slack access is a token Jeremy copies.** He creates the app, installs it and shares the token. The reference files describe a Connect button and adding a collaborator.
