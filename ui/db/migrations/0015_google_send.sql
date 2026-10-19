-- Google can now send. A reply to an email, and a new email, go out through the outbox like a
-- Slack or Telegram reply, from the owner's own Gmail account, and only while sending is on.
--
-- messages.email   For an email: who it was to and who was copied, its Message-ID and its
--                  References, so a reply goes to the right people and lands in the same thread
--                  in everyone's mail.
-- outbox.details   For an email waiting to go: the account it goes from, its Gmail thread, the
--                  addresses, the subject, and the headers that thread it.
--
-- Safe to run more than once, by the app or by hand in the SQL editor.

alter table messages add column if not exists email jsonb;
alter table outbox add column if not exists details jsonb;

alter table outbox drop constraint if exists outbox_source_check;
alter table outbox add constraint outbox_source_check check (source in ('slack', 'telegram', 'gmail'));
