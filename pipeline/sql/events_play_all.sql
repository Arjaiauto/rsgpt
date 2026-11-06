-- Ticket 28c: lets public.events hold 'play_all' (the "Play all" button on an Ask answer). NOT RUN YET.
-- Run in the Supabase SQL Editor (safe to run twice). Until it runs, the site's play_all events are refused by the
-- table's check constraint; the site swallows that (activity logging never breaks a request) and writes one line to the
-- server log, so nothing else is affected.
--   play_all detail: {answer: <qa_log id>, clips: <number of clips in the queue>}   (answer is absent if the id is unknown)
--
-- The old constraint is the unnamed column check from visitors_events.sql, which Postgres names events_event_type_check.

begin;

alter table public.events drop constraint if exists events_event_type_check;
alter table public.events add constraint events_event_type_check
    check (event_type in ('login', 'page_view', 'find_line', 'play_all'));

comment on table public.events is
    'Actions not already in qa_log / saved_items / reports. detail by type: login {device}; page_view {path, q?, topic?, guest?, ...} (no raw URLs); find_line {q}; play_all {answer?, clips}. device_id is the visitor_id browser cookie.';

commit;

-- ---------- check ----------
select pg_get_constraintdef(oid) as event_type_check
from pg_constraint
where conrelid = 'public.events'::regclass and conname = 'events_event_type_check';
