-- What the owner ticked as important in Settings: Slack channels and people, Telegram groups
-- and people. A message from any of them goes to the top of the inbox, marked Important.
--
-- source       "slack" or "telegram".
-- kind         "chat": a Slack channel, or a Telegram group or channel.
--              "person": someone on Slack or Telegram. Their direct chat with the owner counts,
--              and so does any conversation where they wrote the latest message.
-- external_id  The service's own id for it: a Slack channel or user id, a Telegram chat or user id.
-- name         As it was shown when it was ticked, so the list reads well if it is gone since.
--
-- Locked like every other table (see 0002).
-- Safe to run more than once, by the app or by hand in the SQL editor.

create table if not exists important (
  owner_id     text not null references users(id) on delete cascade,
  source       text not null check (source in ('slack', 'telegram')),
  kind         text not null check (kind in ('chat', 'person')),
  external_id  text not null,
  name         text not null,
  primary key (owner_id, source, kind, external_id)
);
alter table important enable row level security;
