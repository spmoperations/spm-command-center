-- Tasks someone on the team list sends the owner from their own task page (app/my-tasks): a
-- teammate with no login of the dashboard gives the owner a task, which lands on the board.
-- team_members.sends_tasks  Whether they may: the owner turns it on for each person, on the team
--                           list in Settings. Off for everyone to begin with.
-- tasks.sent_by             Who sent it: their id on the team list, so their page lists what
--                           they sent and how far it has got. Empty on every other task.
--
-- Only adds columns: the code running before this one goes on working as it did. Safe to run
-- more than once.

alter table team_members add column if not exists sends_tasks boolean not null default false;
alter table tasks add column if not exists sent_by text;
