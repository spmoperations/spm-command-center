-- Agency, Consulting or Sales for tasks. Someone with a login picks, in Settings, which line each
-- Slack channel, Telegram group and person belongs to. Every task that comes from them is labelled
-- with that line on the board, the tasks already there among them. A line can also be set on a
-- task by hand.
--
-- chat_lines   The team's picks, kept under the owner (the team), whoever made them.
--   source       "slack" or "telegram".
--   kind         "chat": a Slack channel, or a Telegram group or channel.
--                "person": someone on Slack or Telegram. Their direct chat counts.
--   external_id  The service's own id for it, as in `important`.
--   name         As it was shown when it was picked, so the list reads well if it is gone since.
--   line         agency, consulting or sales.
-- tasks.line   Set by hand on the task. Empty: the line of where it came from, if it has one.
--
-- Only adds: the code running before this one goes on working as it did.
-- Locked like every other table (see 0002). Safe to run more than once.

create table if not exists chat_lines (
  owner_id     text not null references users(id) on delete cascade,
  source       text not null check (source in ('slack', 'telegram')),
  kind         text not null check (kind in ('chat', 'person')),
  external_id  text not null,
  name         text not null,
  line         text not null check (line in ('agency', 'consulting', 'sales')),
  primary key (owner_id, source, kind, external_id)
);
alter table chat_lines enable row level security;

alter table tasks add column if not exists line text;
alter table tasks drop constraint if exists tasks_line_check;
alter table tasks add constraint tasks_line_check check (line is null or line in ('agency', 'consulting', 'sales'));
