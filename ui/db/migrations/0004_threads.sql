-- Slack threads.
--
-- A reply in a thread belongs to the message that started the thread. `thread_ts` is that
-- first message's Slack id: set on every reply, and on the first message itself once it has
-- replies. Messages outside any thread leave it empty.
--
-- The outbox carries it too, so a reply written in the dashboard goes into the thread and
-- not to the top of the channel.
--
-- Safe to run more than once, by the app or by hand in the SQL editor.

alter table messages add column if not exists thread_ts text;
alter table outbox add column if not exists thread_ts text;
create index if not exists messages_thread on messages (conversation_id, thread_ts);
