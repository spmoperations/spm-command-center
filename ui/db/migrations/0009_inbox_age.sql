-- Old conversations leave the inbox by themselves.
--
-- A conversation with nothing new for a few days is marked done by the sorting rules, so the
-- inbox holds what is current. It is still in the cleared list, and a new message brings it
-- back as always.
--
-- auto_done     True when it was cleared this way and not by the owner. A request still
--               waiting for a reply keeps its suggested task: growing old is not the same as
--               being dealt with.
-- restored_at   When the owner last put it back in the inbox by hand. Its age is counted
--               from then, so it is not cleared again the next minute.
--
-- Safe to run more than once, by the app or by hand in the SQL editor.

alter table conversations add column if not exists auto_done boolean not null default false;
alter table conversations add column if not exists restored_at bigint;
