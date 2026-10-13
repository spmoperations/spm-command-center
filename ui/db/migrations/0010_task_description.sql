-- A description for a task.
--
-- The title says what to do in a line. The description is for the rest: context, links, what
-- done looks like. It is optional, written by the owner, and goes along as the note when the
-- task is assigned to someone as it is created.
--
-- Safe to run more than once, by the app or by hand in the SQL editor.

alter table tasks add column if not exists description text not null default '';
