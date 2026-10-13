-- A message that goes under another one.
--
-- When a task is assigned, the Slack message says what it is and when it is due, and the
-- task's description follows as a reply in that message's thread. The reply cannot be sent
-- until the first message has been, because the thread is named after it.
--
-- after_id   The outbox row this one waits for. Once that row is sent, this one goes into
--            its thread. Empty for an ordinary message.
--
-- Safe to run more than once, by the app or by hand in the SQL editor.

alter table outbox add column if not exists after_id text;
