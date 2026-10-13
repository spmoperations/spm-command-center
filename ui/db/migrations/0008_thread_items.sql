-- One inbox item per thread.
--
-- Until now a Slack channel was one conversation, however many threads the owner was tagged
-- in there. Now each thread addressed to the owner is a conversation of its own (a single
-- message counts as a thread of one), so two threads in one channel are two rows in the
-- inbox, each answered, cleared and turned into a task by itself.
--
-- thread_ts    For such a row, the id of the message that started the thread. Empty for a
--              direct message, a group message, and a channel's own row, which holds what
--              is not addressed to the owner in a channel they follow.
--
-- A channel can now have several rows, so "one row per channel" gives way to "one row per
-- channel and thread".
--
-- Safe to run more than once, by the app or by hand in the SQL editor.

alter table conversations add column if not exists thread_ts text;
alter table conversations drop constraint if exists conversations_owner_id_source_external_id_key;
create unique index if not exists conversations_place on conversations (owner_id, source, external_id, coalesce(thread_ts, ''));
