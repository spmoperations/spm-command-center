-- Command Center: first schema.
--
-- Conventions
--   * Every row belongs to one person (owner_id), so more people can be added later
--     without a rebuild. Phase 1 has a single owner.
--   * Instants are stored as epoch milliseconds (bigint) and calendar days as
--     'YYYY-MM-DD' text. Both read back the same way from every Postgres driver.
--   * Plain Postgres only, so the same file runs on the local database and on Supabase.

create table users (
  id            text primary key,
  name          text not null,
  email         text,
  slack_user_id text,
  created_at    bigint not null
);

-- One row per connected service. The key or token is stored encrypted (AES-256-GCM);
-- the encryption key lives in the server's environment, never in the database.
create table connections (
  owner_id      text not null references users(id) on delete cascade,
  provider      text not null check (provider in ('slack', 'telegram', 'fathom')),
  secret        text not null,
  label         text,
  external_id   text,
  connected_at  bigint not null,
  primary key (owner_id, provider)
);

-- One row per check. `cursor` is the job's bookmark: what it has already seen.
create table jobs (
  owner_id      text not null references users(id) on delete cascade,
  job_id        text not null,
  interval_min  integer not null,
  enabled       boolean not null default true,
  last_run_at   bigint,
  not_before    bigint,
  cursor        jsonb not null default '{}',
  primary key (owner_id, job_id)
);

create table job_runs (
  id            bigserial primary key,
  owner_id      text not null references users(id) on delete cascade,
  job_id        text not null,
  started_at    bigint not null,
  finished_at   bigint,
  ok            boolean,
  items         integer not null default 0,
  message       text
);
create index job_runs_recent on job_runs (owner_id, job_id, started_at desc);

create table slack_users (
  owner_id      text not null references users(id) on delete cascade,
  id            text not null,
  name          text not null,
  email         text,
  is_bot        boolean not null default false,
  deleted       boolean not null default false,
  primary key (owner_id, id)
);

create table slack_channels (
  owner_id      text not null references users(id) on delete cascade,
  id            text not null,
  name          text not null,
  kind          text not null check (kind in ('public', 'private', 'mpim', 'im')),
  -- For a direct message: the other person.
  user_id       text,
  -- Public and private channels are read only when ticked in Settings.
  selected      boolean not null default false,
  primary key (owner_id, id)
);

create table conversations (
  id            text primary key,
  owner_id      text not null references users(id) on delete cascade,
  source        text not null check (source in ('slack', 'telegram')),
  external_id   text not null,
  from_name     text not null,
  ctx           text not null,
  direct        boolean not null default false,
  tagged        boolean not null default false,
  last_text     text not null default '',
  last_at       bigint not null,
  pri           text not null default 'low' check (pri in ('high', 'mid', 'low')),
  line          text not null default 'agency' check (line in ('agency', 'consulting')),
  project       text not null default '',
  done          boolean not null default false,
  replied       boolean not null default false,
  manual_pri    boolean not null default false,
  unique (owner_id, source, external_id)
);
create index conversations_open on conversations (owner_id, done, last_at desc);

create table messages (
  id              text primary key,
  conversation_id text not null references conversations(id) on delete cascade,
  owner_id        text not null references users(id) on delete cascade,
  external_id     text,
  sender_name     text not null,
  me              boolean not null default false,
  body            text not null,
  at              bigint not null,
  -- Set on replies written in the dashboard: queued, sent or failed.
  status          text check (status in ('queued', 'sent', 'failed')),
  -- True once the task finder has read this message.
  scanned         boolean not null default false
);
create index messages_thread on messages (conversation_id, at);
create index messages_unscanned on messages (owner_id, scanned) where not scanned;

create table meetings (
  id            text primary key,
  owner_id      text not null references users(id) on delete cascade,
  external_id   text not null,
  title         text not null,
  started_at    bigint not null,
  duration_min  integer not null default 0,
  who           text not null default '',
  place         text not null default '',
  project       text not null default '',
  url           text,
  summary       text not null default '',
  transcript    jsonb not null default '[]',
  action_items  jsonb not null default '[]',
  unique (owner_id, external_id)
);
create index meetings_recent on meetings (owner_id, started_at desc);

create table team_members (
  id            text primary key,
  owner_id      text not null references users(id) on delete cascade,
  name          text not null,
  role          text not null default '',
  depts         jsonb not null default '[]',
  handles       jsonb not null default '[]',
  slack_user_id text,
  position      integer not null default 0
);

create table tasks (
  id              text primary key,
  owner_id        text not null references users(id) on delete cascade,
  title           text not null,
  dept            text not null,
  project         text not null default '',
  pri             text not null check (pri in ('high', 'mid', 'low')),
  due             text not null,
  done            boolean not null default false,
  done_at         bigint,
  src_type        text check (src_type in ('message', 'meeting')),
  src_id          text,
  delegable       boolean not null default true,
  delegated_to    text,
  delegated_name  text,
  delegated_role  text,
  delegated_note  text,
  delegated_at    bigint,
  created_at      bigint not null
);
create index tasks_owner on tasks (owner_id, done, due);

create table suggestions (
  id            text primary key,
  owner_id      text not null references users(id) on delete cascade,
  title         text not null,
  dept          text not null,
  project       text not null default '',
  pri           text not null check (pri in ('high', 'mid', 'low')),
  due           text not null,
  why           text not null default '',
  src_type      text check (src_type in ('message', 'meeting')),
  src_id        text,
  status        text not null default 'new' check (status in ('new', 'accepted', 'dismissed')),
  delegable     boolean not null default true,
  -- Stops the same suggestion being created twice from the same source.
  dedupe_key    text not null,
  created_at    bigint not null,
  unique (owner_id, dedupe_key)
);

-- Sorting rules. kind 'priority' sets pri, kind 'label' sets line. Lowest position wins.
create table rules (
  id            text primary key,
  owner_id      text not null references users(id) on delete cascade,
  kind          text not null check (kind in ('priority', 'label')),
  position      integer not null,
  source        text not null check (source in ('any', 'slack', 'telegram')),
  match_on      text not null check (match_on in ('any', 'direct', 'tagged', 'ctx', 'from')),
  op            text not null default 'is' check (op in ('is', 'starts', 'contains')),
  value         text not null default '',
  pri           text check (pri in ('high', 'mid', 'low')),
  line          text check (line in ('agency', 'consulting'))
);

create table metrics (
  owner_id      text not null references users(id) on delete cascade,
  id            text not null,
  parent        text,
  name          text not null,
  target        double precision not null,
  unit          text not null check (unit in ('n', '$')),
  is_sum        boolean not null default false,
  position      integer not null default 0,
  primary key (owner_id, id)
);

create table metric_logs (
  owner_id      text not null references users(id) on delete cascade,
  metric_id     text not null,
  day           text not null,
  value         double precision not null,
  primary key (owner_id, metric_id, day)
);

create table focus_items (
  id            text primary key,
  owner_id      text not null references users(id) on delete cascade,
  scope         text not null check (scope in ('day', 'week')),
  period        text not null,
  body          text not null,
  done          boolean not null default false,
  position      bigint not null
);

create table quick_links (
  id            text primary key,
  owner_id      text not null references users(id) on delete cascade,
  label         text not null,
  url           text not null,
  position      bigint not null
);

-- Messages waiting to go out through the person's own Slack or Telegram account.
create table outbox (
  id              text primary key,
  owner_id        text not null references users(id) on delete cascade,
  source          text not null check (source in ('slack', 'telegram')),
  -- Where to send: a channel id, or a person's id for a direct message.
  target          text,
  to_name         text not null,
  ctx             text not null,
  body            text not null,
  status          text not null default 'queued' check (status in ('queued', 'sent', 'failed')),
  attempts        integer not null default 0,
  last_error      text,
  conversation_id text,
  message_id      text,
  task_id         text,
  created_at      bigint not null,
  sent_at         bigint
);
create index outbox_queue on outbox (owner_id, status, created_at);
