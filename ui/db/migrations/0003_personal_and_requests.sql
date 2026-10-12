-- Personal and Professional.
--
-- The dashboard has two sides. Every conversation, task, suggested task, focus item and quick
-- link belongs to one of them. Everything that exists already is Professional.
--
-- Safe to run more than once, by the app or by hand in the SQL editor. The app applies it on
-- its own at start and records it in schema_migrations.

alter table conversations add column if not exists mode text not null default 'professional' check (mode in ('professional', 'personal'));
-- True when the side was picked by hand in the inbox, so the rules no longer change it.
alter table conversations add column if not exists manual_mode boolean not null default false;
alter table tasks add column if not exists mode text not null default 'professional' check (mode in ('professional', 'personal'));
alter table suggestions add column if not exists mode text not null default 'professional' check (mode in ('professional', 'personal'));
alter table focus_items add column if not exists mode text not null default 'professional' check (mode in ('professional', 'personal'));
alter table quick_links add column if not exists mode text not null default 'professional' check (mode in ('professional', 'personal'));

-- A label rule can now also file a chat under Personal.
alter table rules add column if not exists mode text check (mode in ('professional', 'personal'));

-- True once the request finder has looked at this message. It finds messages that ask the
-- owner for something, using plain rules and no AI.
alter table messages add column if not exists asked boolean not null default false;
