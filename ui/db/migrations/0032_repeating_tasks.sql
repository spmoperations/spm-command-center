-- Repeating tasks: the same ticket made again on the same days each week, for the same person,
-- at 6:00 Central European time, and they are told on Slack each time, as when a ticket is
-- assigned on the board (see server/repeats.ts).
--
-- repeating_tasks   One per repeating task, the team's: owner_id is the owner, as for tickets.
--   assignee        Who each one is for: 'member:<id>' on the team list, or 'user:<id>' a login.
--   days            The days of the week it is made on, Monday 1 to Sunday 7.
--   notify          Where they are told: ["slack"], ["telegram"], or [] for nowhere.
--   set_by          The login that set it up, or last changed it: each one is made, and the person
--                   told, from that login's own account. Removing that login removes it.
--   active          False while it is paused.
--   last_day        The last day (YYYY-MM-DD, Central European time) one was made, so a day makes
--                   one at most. Set to the day it was set up when 6:00 had passed already.
--   problem         What went wrong the last time, shown on the board. Empty when it went well.
-- tasks.repeat_id   The repeating task a ticket was made by. Empty on every other ticket.
--
-- Only adds: the code running before this one goes on working as it did. Locked like every
-- other table (see 0002). Safe to run more than once.

create table if not exists repeating_tasks (
  id          text primary key,
  owner_id    text not null references users(id) on delete cascade,
  title       text not null,
  description text not null default '',
  project     text not null default '',
  pri         text not null default 'mid' check (pri in ('high', 'mid', 'low')),
  line        text check (line is null or line in ('agency', 'consulting', 'sales')),
  assignee    text not null,
  days        jsonb not null default '[]',
  notify      jsonb not null default '[]',
  set_by      text not null references users(id) on delete cascade,
  active      boolean not null default true,
  last_day    text,
  problem     text,
  created_at  bigint not null,
  updated_at  bigint not null
);
create index if not exists repeating_tasks_owner on repeating_tasks (owner_id, active);
alter table repeating_tasks enable row level security;

alter table tasks add column if not exists repeat_id text;
