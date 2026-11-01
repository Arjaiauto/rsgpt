-- Ticket 25b: the welcome tour is shown once per person. NOT RUN YET. Run in the Supabase SQL Editor (safe to run twice).
--
-- visitors.tour_seen_at is set the first time a person closes the tour (finishes, skips or presses Esc). It is keyed by
-- the visitor (their lower-cased first name), so the same name on a new phone or laptop does not see the tour again.
-- A signed cookie on the device is only a fast first check that saves a database read; this column is the record.
-- Nobody is back-filled: every existing visitor, including the owner and test names, will see the tour once. To see it
-- again while testing:  update public.visitors set tour_seen_at = null where name_key = 'tester';
-- The function is called only by the site's server (service role), after the response has been sent.

begin;

alter table public.visitors add column if not exists tour_seen_at timestamptz;

comment on column public.visitors.tour_seen_at is
    'When this person first closed the welcome tour (null: not yet, so the tour opens on their next page load).';

-- Marks the tour as seen for a first name, creating the visitor if they have none yet. Keeps the first time.
create or replace function public.mark_tour_seen(p_name text)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
    vid bigint := public.visitor_for(p_name);
begin
    if vid is not null then
        update public.visitors set tour_seen_at = now() where id = vid and tour_seen_at is null;
    end if;
end;
$$;

revoke all on function public.mark_tour_seen(text) from public, anon, authenticated;
grant execute on function public.mark_tour_seen(text) to service_role;

-- The Table Editor view gets the new column last (CREATE OR REPLACE VIEW only allows added columns at the end).
create or replace view public.visitor_activity with (security_invoker = true) as
select v.id, v.name, v.first_seen, v.last_seen, v.login_count, v.last_device_type, v.device_types, v.is_test, v.note,
       (select count(*) from public.qa_log q where q.visitor_ref = v.id and q.kind = 'ask')                                   as asks,
       (select count(*) from public.qa_log q where q.visitor_ref = v.id and q.kind = 'brief' and q.question not like '[web] %') as briefs,
       (select count(*) from public.qa_log q where q.visitor_ref = v.id and q.question like '[web] %')                          as web_research,
       (select count(*) from public.saved_items s where s.visitor_ref = v.id)                                                  as saved,
       (select count(*) from public.reports r where r.visitor_ref = v.id)                                                      as reports,
       (select count(*) from public.events e where e.visitor_ref = v.id and e.event_type = 'page_view')                         as page_views,
       (select count(distinct e.device_id) from public.events e where e.visitor_ref = v.id)                                    as devices,
       v.tour_seen_at
from public.visitors v;

revoke all on public.visitor_activity from anon, authenticated;

commit;

-- Check: how many visitors have seen the tour.
select count(*) filter (where tour_seen_at is not null) as seen, count(*) filter (where tour_seen_at is null) as not_yet from public.visitors;
