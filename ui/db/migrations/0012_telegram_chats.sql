-- The Telegram groups and channels the connected account is in, by name, so a person can
-- choose which ones should always show on the dashboard, tagged or not. Names only: no
-- messages are read from a group here.
--
-- kind       "group" or "channel".
-- last_at    When the newest message there was written, epoch milliseconds.
-- seen_at    When the check last found it in the account's chat list. Once a day the whole
--            list is read, and a group that has gone from it is removed.
--
-- Locked like every other table (see 0002).
-- Safe to run more than once, by the app or by hand in the SQL editor.

create table if not exists telegram_chats (
  owner_id   text not null references users(id) on delete cascade,
  id         text not null,
  name       text not null,
  kind       text not null check (kind in ('group', 'channel')),
  last_at    bigint,
  seen_at    bigint not null,
  primary key (owner_id, id)
);
alter table telegram_chats enable row level security;
