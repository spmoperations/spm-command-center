-- Which Telegram chats each login wants brought in. Only a ticked chat comes in: a one-to-one
-- chat, a group (all of it) or a channel. One-to-one chats are now listed too, by the person's
-- name, beside the groups and channels.
--
-- synced   Ticked under Settings → Telegram chats. A chat already on the dashboard starts
--          ticked, so nothing disappears on the day this arrives; a new chat starts unticked.
--
-- Additive. The code from before this keeps working with it: it never lists one-to-one chats
-- and does not read `synced`. Safe to run more than once, by the app or by hand in the SQL editor.

alter table telegram_chats add column if not exists synced boolean not null default false;

alter table telegram_chats drop constraint if exists telegram_chats_kind_check;
alter table telegram_chats add constraint telegram_chats_kind_check check (kind in ('group', 'channel', 'direct'));

update telegram_chats t set synced = true
where not t.synced and exists (select 1 from conversations c where c.owner_id = t.owner_id and c.id = 'telegram:' || t.id);
