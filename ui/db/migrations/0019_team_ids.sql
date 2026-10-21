-- 0018 made the ids of conversations, messages and meetings unique for each person. Where 0018
-- was run before the code that goes with it, these three indexes kept each id unique across
-- everyone, so the earlier code could go on saving new messages, emails and calls. The code
-- that comes with this migration does not need them, and they would stop two people from each
-- having a row for the same chat, so they go. Where they were never made, nothing happens.
drop index if exists conversations_id_once;
drop index if exists messages_id_once;
drop index if exists meetings_id_once;
