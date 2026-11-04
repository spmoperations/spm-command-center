-- A booking's page name, such as "Introduction Session". Calendly writes it in the invite on the
-- calendar ("Event Name", then the name), so a call booked through a link is known from the
-- calendar alone, with Calendly not connected: the calendar check keeps each Calendly invite it
-- sees as a booking, by name, and a booking link picked in Settings counts for the bookings of
-- the same name. Kept in bookings, so the call keeps its line after the invite leaves the
-- calendar copy (15 days back).
--
-- Only adds a column: the code running before this one goes on working as it did. Safe to run
-- more than once.

alter table bookings add column if not exists name text;
