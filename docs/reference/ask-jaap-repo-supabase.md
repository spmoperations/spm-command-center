# What we need from Jaap

To start we need three things from Jaap: a yes on a new repository, a new Supabase project that Shruti can access, and hosting plus an AI key for it.

## The asks

| # | Ask | Detail | Why |
| --- | --- | --- | --- |
| 1 | A yes on a new repository | Separate from the tracker repository. Tell us which GitHub account should own it, and give Shruti admin on it | A different product, holding the CEO's private messages, with its own releases |
| 2 | A new Supabase project | Separate from the tracker's database. Add Shruti as Administrator. Developer is enough to build (reads the API keys, runs SQL) but cannot change database settings | Database, logins and the job timer live here |
| 3 | Hosting | A project for the new repository on a plan that allows frequent timers. On Vercel that is Pro: Hobby runs a scheduled job once a day at most | Hourly pulls |
| 4 | An AI API key for this project | Anthropic or OpenAI, with a monthly spend limit, separate from the tracker's key | Task suggestions and suggested replies; a separate key keeps the cost visible |
| 5 | The Slack admin | Who can approve a new app in SPM's Slack workspace | Jeremy's Slack connection |
| 6 | The password manager | Which tool SPM uses to share secrets | Handing keys over safely |

On Supabase's Free and Pro plans a member's role covers every project in the organisation; a role for one project only needs the Team plan. If Shruti should see only this project, create it in its own organisation. Projects in a Pro organisation are not paused.

## Message to post

> @Jaap for Jeremy's Command Center, three things so we can start:
>
> 1. Should we create a new repository for it, separate from spm-hook-generator? Which GitHub account should own it?
> 2. Can you create a new Supabase project for it and add me as Administrator? It should be separate from the tracker's database.
> 3. Where do we host it, and can we get an AI API key (Anthropic or OpenAI) for this project?
>
> The full list with the reasons is in the plan doc.
