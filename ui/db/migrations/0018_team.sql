-- Team members get a Command Center of their own: a login, and their own connections and data
-- beside the owner's. Nothing of the owner's changes: their login stays the one in LOGIN_EMAIL,
-- and their rows, ids and connections are left as they are.

-- A team member signs in with this email and password. The owner has neither: they sign in
-- with LOGIN_EMAIL and LOGIN_PASSWORD, as before.
alter table users add column if not exists login_email text;
alter table users add column if not exists password_hash text;
create unique index if not exists users_login_email on users (lower(login_email));

-- The ids of conversations, messages and meetings are unique for each person, not across
-- everyone: two people in the same Slack channel, or on the same call, each have their own row
-- under the same id. The existing rows all belong to the owner and keep their ids.
-- Each step can run again and ends the same way.
alter table messages drop constraint if exists messages_conversation_id_fkey;
alter table messages drop constraint if exists messages_conversation_fkey;
alter table conversations drop constraint if exists conversations_pkey cascade;
alter table conversations add constraint conversations_pkey primary key (owner_id, id);
alter table messages drop constraint if exists messages_pkey;
alter table messages add constraint messages_pkey primary key (owner_id, id);
alter table messages add constraint messages_conversation_fkey foreign key (owner_id, conversation_id) references conversations (owner_id, id) on delete cascade;
alter table meetings drop constraint if exists meetings_pkey;
alter table meetings add constraint meetings_pkey primary key (owner_id, id);
