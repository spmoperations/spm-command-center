-- Pictures the dashboard keeps itself.
--
-- Slack hands a picture over whenever it is asked, so only its address is stored (0006).
-- Telegram's can only be fetched through the logged-in account, one download each. The ones
-- worth showing are kept here: the pictures and stickers of messages, at a size for the
-- screen, and people's small profile pictures. Videos are never kept.
--
-- key        "telegram/<chat>/<message>" for a message's picture,
--            "telegram/avatar/<person>" for a profile picture.
-- bytes      The picture. Empty for a profile picture that was asked for and does not exist,
--            so nobody is asked about twice.
--
-- Locked like every other table (see 0002).
-- Safe to run more than once, by the app or by hand in the SQL editor.

create table if not exists media (
  owner_id   text not null references users(id) on delete cascade,
  key        text not null,
  mime       text not null,
  bytes      bytea not null,
  saved_at   bigint not null,
  primary key (owner_id, key)
);
alter table media enable row level security;
