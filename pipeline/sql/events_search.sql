-- Ticket 27: lets public.events hold 'search' (what someone typed into the search box and what they picked). NOT RUN YET.
-- Run in the Supabase SQL Editor (safe to run twice). Until it runs, the site's search events are refused by the table's
-- check constraint; the site swallows that (activity logging never breaks a request) and writes one line to the server
-- log, so nothing else is affected.
--   search detail: {q: <what was typed, at most 120 characters>, pick?: "<kind>:<ref>" of the suggestion chosen (absent:
--   the text was searched as typed), n?: <number of suggestions shown>}
--
-- Same pattern as events_play_all.sql: the old constraint is the unnamed column check from visitors_events.sql, which
-- Postgres names events_event_type_check. It already allows login, page_view, find_line and play_all; those stay.

begin;

alter table public.events drop constraint if exists events_event_type_check;
alter table public.events add constraint events_event_type_check
    check (event_type in ('login', 'page_view', 'find_line', 'play_all', 'search'));

comment on table public.events is
    'Actions not already in qa_log / saved_items / reports. detail by type: login {device}; page_view {path, q?, topic?, guest?, ...} (no raw URLs); find_line {q}; play_all {answer?, clips}; search {q, pick?, n?}. device_id is the visitor_id browser cookie.';

commit;

-- ---------- check ----------
select pg_get_constraintdef(oid) as event_type_check
from pg_constraint
where conrelid = 'public.events'::regclass and conname = 'events_event_type_check';
