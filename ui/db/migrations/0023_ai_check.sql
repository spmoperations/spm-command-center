-- The AI check: each message the request finder flags is read by the AI model, with the
-- conversation around it, before it counts as a task. See src/jobs/task-check.ts.
--
-- suggestions
--   checked_at  When the AI read it. Empty: not read yet, and shown as "Not checked yet".
--   confidence  How sure the model is that it is a real task, 0 to 100. Empty when nobody asked
--               the model, or when a person put back what the model had set aside.
--
-- A suggestion the model says is not a task is turned down with the reason "not_task" and kept,
-- so anyone can see what was set aside and put it back.
--
-- Only adds: the code running before this one goes on working as it did. Safe to run more than once.

alter table suggestions add column if not exists checked_at bigint;
alter table suggestions add column if not exists confidence integer;
