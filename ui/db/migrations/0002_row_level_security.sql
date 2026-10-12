-- Lock every table to the server.
--
-- Supabase publishes the tables of the public schema through its web API. With row level
-- security switched on and no policies, that API returns nothing: only the Command Center's
-- own server, which connects as the database owner, can read or write. This must stay in
-- place until there is a login per person and policies that use it.
--
-- Safe to run more than once, by the app or by hand in the SQL editor. The app's own
-- bookkeeping table, schema_migrations, is locked by the app when it creates it.

alter table users enable row level security;
alter table connections enable row level security;
alter table jobs enable row level security;
alter table job_runs enable row level security;
alter table slack_users enable row level security;
alter table slack_channels enable row level security;
alter table conversations enable row level security;
alter table messages enable row level security;
alter table meetings enable row level security;
alter table team_members enable row level security;
alter table tasks enable row level security;
alter table suggestions enable row level security;
alter table rules enable row level security;
alter table metrics enable row level security;
alter table metric_logs enable row level security;
alter table focus_items enable row level security;
alter table quick_links enable row level security;
alter table outbox enable row level security;
