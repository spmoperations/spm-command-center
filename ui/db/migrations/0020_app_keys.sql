-- App keys: the keys of a service's app that every login through it needs, kept in the database
-- for each person instead of in the server's settings. Google: the OAuth client's Client ID and
-- secret from Google Cloud. Telegram: the api_id and api_hash from my.telegram.org. The AI: the
-- Anthropic key.
--
-- secret      The keys, sealed like every login (AES-256-GCM with SECRETS_KEY).
-- label       What may be shown: part of the Client ID, the last digits of the api_id.
-- from_env    Copied once from the server's settings as the owner's keys. A connection made
--             before keys were kept here was made with these.
-- retired_at  Replaced by newer keys: no new connection uses it, the ones made with it keep it.
--
-- Each Google account and Telegram login remembers the keys it was made with (app_key_id), so
-- saving new keys never touches a connection made before. Empty for a connection made before
-- this table: those were made with the server's settings.
--
-- Only adds: the code running before this one goes on working as it did.
-- Locked like every other table (see 0002). Safe to run more than once.

create table if not exists app_keys (
  id          text primary key,
  owner_id    text not null references users(id) on delete cascade,
  provider    text not null check (provider in ('google', 'telegram', 'anthropic')),
  secret      text not null,
  label       text not null,
  from_env    boolean not null default false,
  created_at  bigint not null,
  retired_at  bigint
);
create unique index if not exists app_keys_current on app_keys (owner_id, provider) where retired_at is null;
alter table app_keys enable row level security;

alter table connections add column if not exists app_key_id text;
alter table google_accounts add column if not exists app_key_id text;
