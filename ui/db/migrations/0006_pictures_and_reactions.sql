-- Pictures, stickers and reactions on messages.
--
-- attachments  The pictures and stickers sent with a message. For Slack, the addresses Slack
--              serves each one from. For Telegram, the name of the file kept on the machine
--              the app runs on. Videos are never kept.
-- reactions    The emoji people put on a message: which, how many, and whether the owner did.
-- sender_id    Who wrote the message, as its app knows them. Used to find a profile picture.
-- scopes       What the connected Slack app is allowed to do. Showing pictures needs one
--              permission more than reading messages, and this says whether it is there.
--
-- Safe to run more than once, by the app or by hand in the SQL editor.

alter table messages add column if not exists attachments jsonb not null default '[]';
alter table messages add column if not exists reactions jsonb not null default '[]';
alter table messages add column if not exists sender_id text;
alter table connections add column if not exists scopes text;
