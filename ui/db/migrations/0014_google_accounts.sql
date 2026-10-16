-- Google, with more than one account. `connections` keeps one login per service, so each
-- connected Google account has a row of its own here instead.
--
-- google_accounts
--   email          The account's address. One row each.
--   secret         The lasting login (a refresh token), encrypted like every other key.
--   scopes         What the account allowed on Google's page, comma separated: Gmail, Calendar or both.
--   start_history  Where the mailbox stood when it was connected (Gmail's historyId). Emails that
--                  arrive after it come into the inbox; nothing from before is read.
--
-- calendar_events is made again, keyed by account as well: the same meeting has the same id in
-- every invitee's calendar. It only ever holds a copy of the calendars, which the next check
-- fills again, so nothing is lost by dropping it.
--   account        Whose calendar the event is on.
--   all_day        An event with dates and no times. Its start_at and end_at are midnight UTC
--                  of the first day and of the day after the last.
--   kind           Google's eventType: "default" for a meeting, "outOfOffice", "focusTime", "fromGmail".
--
-- A Google login kept the earlier way, in `connections`, is not carried over: connect again.
-- Locked like every other table (see 0002).
-- Safe to run more than once, by the app or by hand in the SQL editor.

create table if not exists google_accounts (
  owner_id       text not null references users(id) on delete cascade,
  email          text not null,
  secret         text not null,
  scopes         text not null default '',
  start_history  text,
  connected_at   bigint not null,
  primary key (owner_id, email)
);
alter table google_accounts enable row level security;

delete from connections where provider = 'google';

drop table if exists calendar_events;
create table calendar_events (
  owner_id    text not null references users(id) on delete cascade,
  account     text not null,
  id          text not null,
  title       text not null,
  start_at    bigint not null,
  end_at      bigint not null,
  all_day     boolean not null default false,
  kind        text not null default 'default',
  location    text,
  link        text,
  html_link   text,
  organizer   text,
  attendees   jsonb not null default '[]',
  response    text,
  saved_at    bigint not null,
  primary key (owner_id, account, id)
);
alter table calendar_events enable row level security;
