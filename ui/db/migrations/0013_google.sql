-- Google: Gmail threads come into the inbox, and the meetings coming up on the main calendar
-- show on the Meetings tab. Read-only: nothing is sent through Google, so the outbox stays as
-- it is.
--
-- The checks that list the services now include Google (a connection) and Gmail (where an
-- inbox row came from, and what a rule can be about). Each is dropped and made again.
--
-- calendar_events  The events on the owner's main calendar from a little before now to the end
--                  of tomorrow, as the last check found them. Each check replaces that window.
--   start_at, end_at   Epoch milliseconds. For an all-day event, midnight UTC of its dates.
--   all_day            An event with dates and no times.
--   time_zone          The zone the event was set in, or else the calendar's.
--   link               Where to join: the Meet link, or another video link in the event.
--   attendees          [{ "name", "email", "response" }], without the owner and rooms.
--   response           The owner's own answer: accepted, tentative or needsAction.
--
-- Locked like every other table (see 0002).
-- Safe to run more than once, by the app or by hand in the SQL editor.

alter table connections drop constraint if exists connections_provider_check;
alter table connections add constraint connections_provider_check check (provider in ('slack', 'telegram', 'fathom', 'google'));

alter table conversations drop constraint if exists conversations_source_check;
alter table conversations add constraint conversations_source_check check (source in ('slack', 'telegram', 'gmail'));

alter table rules drop constraint if exists rules_source_check;
alter table rules add constraint rules_source_check check (source in ('any', 'slack', 'telegram', 'gmail'));

create table if not exists calendar_events (
  owner_id    text not null references users(id) on delete cascade,
  id          text not null,
  title       text not null,
  start_at    bigint not null,
  end_at      bigint not null,
  all_day     boolean not null default false,
  time_zone   text,
  location    text,
  link        text,
  html_link   text,
  organizer   text,
  attendees   jsonb not null default '[]',
  response    text,
  saved_at    bigint not null,
  primary key (owner_id, id)
);
alter table calendar_events enable row level security;
