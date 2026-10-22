-- Slack's app keys (the Client ID and Client Secret of one Slack app for the whole team) can be
-- kept with the others, so each person connects Slack with one click and gets a token of their own.
-- Only widens what may be stored: the code running before this one goes on working.
-- Safe to run more than once.
alter table app_keys drop constraint if exists app_keys_provider_check;
alter table app_keys add constraint app_keys_provider_check check (provider in ('google', 'telegram', 'anthropic', 'slack'));
