-- Task logins: someone on the team list, such as an editor, signs in and sees only the tickets given to
-- them, nothing else. They sign in with Google, when their email is a Google account such as a
-- Social Profit Media one, or with an email and password. Not a Command Center of their own
-- like a team login (a `users` row): they have no inbox, no connections and no checks.
--
-- member_id      The person on the team list. Taking them off the list removes their login.
-- email          What they sign in with: Google's account, or the email they type.
-- password_hash  scrypt, salted, as for team logins. Empty: Google only.
-- since          When the login was made or last changed: every session made before ends.
-- last_in        When they last signed in.
--
-- One email signs in as one person. Only adds: the code running before this one goes on working
-- as it did. Locked like every other table (see 0002). Safe to run more than once.

create table if not exists task_logins (
  member_id      text primary key references team_members(id) on delete cascade,
  owner_id       text not null references users(id) on delete cascade,
  email          text not null,
  password_hash  text,
  since          bigint not null,
  last_in        bigint
);
create unique index if not exists task_logins_email on task_logins (lower(email));
alter table task_logins enable row level security;
