-- Agency, Consulting or Sales for calls. Two more kinds of pick, kept with the chat picks in
-- chat_lines, for the whole team:
--   source 'fathom',   kind 'call':     a call by its title, written small with single spaces.
--                                        Every call with that title counts: a weekly check-in is
--                                        one pick.
--   source 'calendly', kind 'booking':  a Calendly booking link without https://, such as
--                                        calendly.com/team/intro-call. A call booked through it
--                                        counts.
-- A call's booking link comes first, then its title. A label set on a task by hand still wins.
--
-- Calendly is connected with a key, kept in connections like Fathom's.
-- booking_types   The booking links (event types) Calendly lists, to pick from in Settings.
-- bookings        Calls booked through Calendly: when, through which link, and who hosted. A call
--                 from Fathom within 15 minutes of one, with one of its hosts invited, is that
--                 booking.
-- meetings.scheduled_at  When the call was on the calendar, as Fathom says.
-- meetings.guests        Who was invited, by email address in small letters.
--                        Both are empty on calls read before this one.
--
-- Only adds and widens: the code running before this one goes on working as it did.
-- Locked like every other table (see 0002). Safe to run more than once.

alter table connections drop constraint if exists connections_provider_check;
alter table connections add constraint connections_provider_check check (provider in ('slack', 'telegram', 'fathom', 'google', 'calendly'));

alter table chat_lines drop constraint if exists chat_lines_source_check;
alter table chat_lines add constraint chat_lines_source_check check (source in ('slack', 'telegram', 'fathom', 'calendly'));
alter table chat_lines drop constraint if exists chat_lines_kind_check;
alter table chat_lines add constraint chat_lines_kind_check check (kind in ('chat', 'person', 'call', 'booking'));

create table if not exists booking_types (
  owner_id   text not null references users(id) on delete cascade,
  link       text not null,
  name       text not null,
  active     boolean not null default true,
  saved_at   bigint not null,
  primary key (owner_id, link)
);
alter table booking_types enable row level security;

create table if not exists bookings (
  owner_id   text not null references users(id) on delete cascade,
  id         text not null,
  link       text,
  start_at   bigint not null,
  end_at     bigint not null,
  hosts      text[] not null default '{}',
  active     boolean not null default true,
  saved_at   bigint not null,
  primary key (owner_id, id)
);
create index if not exists bookings_start on bookings (owner_id, start_at);
alter table bookings enable row level security;

alter table meetings add column if not exists scheduled_at bigint;
alter table meetings add column if not exists guests text[];
