-- Clients: the names a ticket can be filed under, kept for the team. A client typed into a
-- ticket or a review card and confirmed with Enter is kept here, so it can be picked next time
-- even before any ticket uses it. The clients that tickets, calls and chats already name are
-- offered too, without being copied here.
--
-- One name once per team, whatever its capitals.
--
-- Only adds: the code running before this one goes on working as it did.
-- Locked like every other table (see 0002). Safe to run more than once.

create table if not exists clients (
  owner_id    text not null references users(id) on delete cascade,
  name        text not null,
  created_at  bigint not null
);
create unique index if not exists clients_once on clients (owner_id, lower(name));
alter table clients enable row level security;
