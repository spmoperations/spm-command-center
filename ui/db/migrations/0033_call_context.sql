-- What a task from a call is about, written from the call (see jobs/call-context.ts): what to
-- do, why, and the details said on the call, so whoever it is for does not need the recording.
--
-- suggestions.context  The write-up for an action item from a call. Empty (null) until the check
--                      has read the call; '' when it read it and had nothing to write. Becomes
--                      the task's description when the suggestion is made a task.
--
-- Only adds a column: the code running before this one goes on working as it did. Safe to run
-- more than once.

alter table suggestions add column if not exists context text;
