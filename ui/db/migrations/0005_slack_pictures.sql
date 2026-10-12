-- Slack profile pictures.
--
-- The address of each person's picture, as Slack gives it with the people list. The inbox
-- shows it beside their messages. Only the address is kept; the picture stays with Slack.
--
-- Safe to run more than once, by the app or by hand in the SQL editor.

alter table slack_users add column if not exists image text;
