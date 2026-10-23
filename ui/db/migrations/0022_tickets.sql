-- Tickets: the team's tasks on one board that everyone with a login shares, and the review of
-- what the checks flag before it becomes a ticket.
--
-- tasks
--   status        Open, In progress, Waiting (on someone) or Done. `done` stays the truth for
--                 done-ness, so code that only knows `done` keeps working.
--   number        The ticket's number on the board (SPM-12), counted per team.
--   assignee_user A login (users.id) the ticket is for, such as the owner or Alex. A team member
--                 without a login is `delegated_to`, as before. Neither: nobody's yet.
--   created_by    The login that made it.
--   source_owner  The login whose inbox or call it came from: `src_id` is that person's row.
--   src_quote, src_label, src_link
--                 The line it came from, where ("Slack · #sales") and a link to it, kept with the
--                 ticket so everyone on the team can read it, not only whoever's inbox it is.
-- suggestions
--   reason        Why it was turned down: not a task, a duplicate, already done, the wrong
--                 person, chit-chat or something else.
--   for_name      Who it is for, as the source says (Fathom's assignee).
--   looks_done    Why it may be done already, when something says so.
--   ticket_id     The ticket it became, or was merged into.
-- team_members
--   telegram_id   Their Telegram account, so an assignment can reach them there too.
-- ticket_events   What happened to each ticket, by whom: its history.
--
-- Only adds: the code running before this one goes on working as it did.
-- Locked like every other table (see 0002). Safe to run more than once.

alter table tasks add column if not exists status text not null default 'open';
alter table tasks drop constraint if exists tasks_status_check;
alter table tasks add constraint tasks_status_check check (status in ('open', 'in_progress', 'waiting', 'done'));
update tasks set status = 'done' where done and status <> 'done';
alter table tasks add column if not exists number integer;
alter table tasks add column if not exists assignee_user text;
alter table tasks add column if not exists created_by text;
alter table tasks add column if not exists source_owner text;
alter table tasks add column if not exists src_quote text;
alter table tasks add column if not exists src_label text;
alter table tasks add column if not exists src_link text;
alter table tasks add column if not exists updated_at bigint;

-- Every task already there gets the next number, oldest first, after any number already given.
update tasks t set number = n.base + n.rn
from (
  select id, row_number() over (partition by owner_id order by created_at, id) as rn,
         coalesce((select max(x.number) from tasks x where x.owner_id = tasks.owner_id), 0) as base
  from tasks where number is null
) n
where t.id = n.id;
create unique index if not exists tasks_number on tasks (owner_id, number) where number is not null;

alter table suggestions add column if not exists reason text;
alter table suggestions add column if not exists for_name text;
alter table suggestions add column if not exists looks_done text;
alter table suggestions add column if not exists ticket_id text;

alter table team_members add column if not exists telegram_id text;

create table if not exists ticket_events (
  id        text primary key,
  owner_id  text not null references users(id) on delete cascade,
  task_id   text not null,
  at        bigint not null,
  by_user   text,
  by_name   text not null default '',
  what      text not null
);
create index if not exists ticket_events_task on ticket_events (owner_id, task_id, at);
alter table ticket_events enable row level security;
