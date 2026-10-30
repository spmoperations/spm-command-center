-- Due dates only where the call or the message named a day (see namedDay in core/requests.ts).
-- Until now a suggestion that named none was given one anyway: two days after the call for a
-- Fathom action item, the next day for a request in a message. This clears those made-up dates
-- on the cards still waiting in the review, so they show no due date. A card whose words name a
-- day keeps its date. Tickets already on the board keep theirs: someone accepted them with it.
--
-- Only changes data. Run it once the code that shows "No due date" is live: the code before it
-- shows these cards as due today. Safe to run more than once.

update suggestions set due = ''
where status = 'new' and src_type = 'meeting' and due <> ''
  and title !~* '\m(today|tonight|eod|asap|urgent|urgently|tomorrow|tmrw|tmr|eow|eom|right now|end of (the )?(day|week|month)|this (morning|afternoon|evening)|(by|on|before|this|until|till|next) (sun|mon|tue|wed|thu|fri|sat)[a-z]*|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? [0-9]{1,2}|[0-9]{1,2}(st|nd|rd|th)? (of )?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))\M';

update suggestions s set due = ''
where s.status = 'new' and s.dedupe_key like 'ask:%' and s.due <> ''
  and not exists (
    select 1 from messages m where m.owner_id = s.owner_id and m.id = substr(s.dedupe_key, 5)
      and m.body ~* '\m(today|tonight|eod|asap|urgent|urgently|tomorrow|tmrw|tmr|eow|eom|right now|end of (the )?(day|week|month)|this (morning|afternoon|evening)|(by|on|before|this|until|till|next) (sun|mon|tue|wed|thu|fri|sat)[a-z]*|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? [0-9]{1,2}|[0-9]{1,2}(st|nd|rd|th)? (of )?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))\M'
  );
