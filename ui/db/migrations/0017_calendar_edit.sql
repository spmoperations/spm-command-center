-- Events can now be changed, deleted and answered from the Calendar tab.
--
-- mine         The owner made it (is its organizer): it can be changed and deleted from here,
--              and its guests are told. An invitation from someone else is answered instead.
-- description  Its notes, for the form that changes it.
-- recurring    One occurrence of a repeating event: a change or a delete is for that one only.
--
-- Safe to run more than once, by the app or by hand in the SQL editor.

alter table calendar_events add column if not exists mine boolean not null default false;
alter table calendar_events add column if not exists description text;
alter table calendar_events add column if not exists recurring boolean not null default false;
