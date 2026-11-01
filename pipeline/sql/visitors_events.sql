-- Ticket 25a: who uses the site and what they do. NOT RUN YET. Run in the Supabase SQL Editor (safe to run twice).
--
--   visitors  one row per person, keyed by their lower-cased first name (the login asks for a first name only).
--             The same name on a new phone or laptop is the same visitor. Two different people who share a first
--             name are one row too (see `note`); their devices are told apart by events.device_id.
--   events    one row per action that qa_log / saved_items / reports do not already record (login, page visits,
--             find-a-line searches), with a small JSON detail.
--   visitor_ref   new column on qa_log, saved_items and reports. The existing text column `visitor_id` is the
--             browser cookie (a device), so the link to a person gets its own name. A trigger fills it on every
--             insert, so the code that writes those tables does not change.
--   visitor_activity   a view for the Table Editor: one line per visitor with counts.
--
-- No IP address, user agent or password is stored. Device type is only phone / desktop / tablet, worked out on the
-- server at login from the request, then the raw header is thrown away.
-- All tables: Row Level Security on, no policies, nothing for anon / authenticated (the site's server uses the
-- service role). The site writes to these AFTER the response is sent (Next `after()`), never inside a request's
-- critical path, and swallows every logging error.
--
-- One transaction: either everything below is applied or nothing is. Safe to run again: tables / columns / indexes use
-- IF NOT EXISTS, functions and the view use CREATE OR REPLACE, triggers are dropped and recreated, and the backfill
-- uses ON CONFLICT. The last statement is one SELECT that shows the result (the SQL Editor only shows the last
-- statement's output, so the three checks are stacked into a single result: section / item / value).

begin;

-- ---------- visitors ----------
create table if not exists public.visitors (
    id               bigint generated always as identity primary key,
    name_key         text        not null unique check (name_key = lower(btrim(name_key)) and name_key <> ''),
    name             text        not null,
    first_seen       timestamptz not null default now(),
    last_seen        timestamptz not null default now(),
    login_count      integer     not null default 0,
    last_device_type text check (last_device_type in ('phone', 'desktop', 'tablet')),
    device_types     text[]      not null default '{}' check (device_types <@ array['phone', 'desktop', 'tablet']),
    is_test          boolean     not null default false,
    note             text
);

comment on table public.visitors is
    'One row per person, keyed by lower-cased first name. login_count and device_types count from the day this ran; first_seen/last_seen are backfilled from the old logs. is_test marks the owner''s and test names (see is_test_name()).';

-- ---------- events ----------
create table if not exists public.events (
    id          bigint generated always as identity primary key,
    visitor_ref bigint references public.visitors (id) on delete set null,
    device_id   text,
    event_type  text not null check (event_type in ('login', 'page_view', 'find_line')),
    detail      jsonb not null default '{}'::jsonb check (octet_length(detail::text) <= 1000),
    created_at  timestamptz not null default now()
);

create index if not exists events_visitor_created_idx on public.events (visitor_ref, created_at desc);
create index if not exists events_type_created_idx    on public.events (event_type, created_at desc);

comment on table public.events is
    'Actions not already in qa_log / saved_items / reports. detail by type: login {device}; page_view {path, q?, topic?, guest?, ...} (no raw URLs); find_line {q}. device_id is the visitor_id browser cookie.';

alter table public.visitors enable row level security;
alter table public.events   enable row level security;
revoke all on table public.visitors from anon, authenticated;
revoke all on table public.events   from anon, authenticated;

-- ---------- link from the old log tables ----------
alter table public.qa_log      add column if not exists visitor_ref bigint references public.visitors (id) on delete set null;
alter table public.saved_items add column if not exists visitor_ref bigint references public.visitors (id) on delete set null;
alter table public.reports     add column if not exists visitor_ref bigint references public.visitors (id) on delete set null;

create index if not exists qa_log_visitor_ref_idx      on public.qa_log      (visitor_ref, created_at desc);
create index if not exists saved_items_visitor_ref_idx on public.saved_items (visitor_ref);
create index if not exists reports_visitor_ref_idx     on public.reports     (visitor_ref);

-- ---------- functions ----------
-- Names that are not real use: the owner and test traffic (lower-cased). One list, used by every function and the backfill.
create or replace function public.is_test_name(p_key text)
returns boolean
language sql
immutable
set search_path = public
as $$ select p_key in ('arjun', 'test-script', 'tester', 'test-other') $$;

-- The visitor for a first name; creates the row on first sight (without counting a login). Null for an empty name.
create or replace function public.visitor_for(p_name text)
returns bigint
language plpgsql
security invoker
set search_path = public
as $$
declare
    k text := lower(btrim(coalesce(p_name, '')));
    v bigint;
begin
    if k = '' then return null; end if;
    select id into v from public.visitors where name_key = k;
    if v is null then
        insert into public.visitors (name_key, name, is_test)
        values (k, btrim(p_name), public.is_test_name(k))
        on conflict (name_key) do nothing;
        select id into v from public.visitors where name_key = k;
    end if;
    return v;
end;
$$;

-- One call at login: creates or updates the visitor (one atomic upsert) and writes the 'login' event.
create or replace function public.record_login(p_name text, p_device_type text, p_device_id text)
returns bigint
language plpgsql
security invoker
set search_path = public
as $$
declare
    k   text := lower(btrim(coalesce(p_name, '')));
    dev text := case when p_device_type in ('phone', 'desktop', 'tablet') then p_device_type else null end;
    vid bigint;
begin
    if k = '' then return null; end if;
    insert into public.visitors as v (name_key, name, login_count, last_device_type, device_types, is_test)
    values (k, btrim(p_name), 1, dev, case when dev is null then '{}' else array[dev] end, public.is_test_name(k))
    on conflict (name_key) do update set
        last_seen        = now(),
        login_count      = v.login_count + 1,
        last_device_type = coalesce(dev, v.last_device_type),
        device_types     = case when dev is null or dev = any (v.device_types) then v.device_types else v.device_types || dev end
    returning v.id into vid;
    insert into public.events (visitor_ref, device_id, event_type, detail)
    values (vid, left(p_device_id, 64), 'login', jsonb_build_object('device', dev));
    return vid;
end;
$$;

-- One call per logged action. last_seen moves at most once a minute per visitor, to keep writes down.
create or replace function public.log_event(p_name text, p_device_id text, p_type text, p_detail jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
    vid bigint := public.visitor_for(p_name);
begin
    insert into public.events (visitor_ref, device_id, event_type, detail)
    values (vid, left(p_device_id, 64), p_type, coalesce(p_detail, '{}'::jsonb));
    if vid is not null then
        update public.visitors set last_seen = now() where id = vid and last_seen < now() - interval '1 minute';
    end if;
end;
$$;

-- Fills visitor_ref on every new qa_log / saved_items / reports row from its first_name. If anything goes wrong the
-- row is still saved, just without the link.
create or replace function public.set_visitor_ref()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
    if new.visitor_ref is null then
        begin
            new.visitor_ref := public.visitor_for(new.first_name);
        exception when others then
            new.visitor_ref := null;
        end;
    end if;
    return new;
end;
$$;

drop trigger if exists qa_log_visitor_ref      on public.qa_log;
drop trigger if exists saved_items_visitor_ref on public.saved_items;
drop trigger if exists reports_visitor_ref     on public.reports;
create trigger qa_log_visitor_ref      before insert on public.qa_log      for each row execute function public.set_visitor_ref();
create trigger saved_items_visitor_ref before insert on public.saved_items for each row execute function public.set_visitor_ref();
create trigger reports_visitor_ref     before insert on public.reports     for each row execute function public.set_visitor_ref();

revoke all on function public.is_test_name(text)                     from public, anon, authenticated;
revoke all on function public.visitor_for(text)                      from public, anon, authenticated;
revoke all on function public.record_login(text, text, text)         from public, anon, authenticated;
revoke all on function public.log_event(text, text, text, jsonb)     from public, anon, authenticated;
revoke all on function public.set_visitor_ref()                      from public, anon, authenticated;
grant execute on function public.is_test_name(text)                  to service_role;
grant execute on function public.visitor_for(text)                   to service_role;
grant execute on function public.record_login(text, text, text)      to service_role;
grant execute on function public.log_event(text, text, text, jsonb)  to service_role;
grant execute on function public.set_visitor_ref()                   to service_role;

-- ---------- backfill (old rows, by name) ----------
-- 1. A visitor for every first name in the old logs; first_seen / last_seen from the oldest and newest row.
insert into public.visitors (name_key, name, first_seen, last_seen, is_test)
select lower(btrim(t.first_name)),
       (array_agg(btrim(t.first_name) order by t.created_at))[1],
       min(t.created_at), max(t.created_at),
       public.is_test_name(lower(btrim(t.first_name)))
from (
    select first_name, created_at from public.qa_log
    union all select first_name, created_at from public.saved_items
    union all select first_name, created_at from public.reports
) t
where btrim(coalesce(t.first_name, '')) <> ''
group by lower(btrim(t.first_name))
on conflict (name_key) do update set
    first_seen = least(public.visitors.first_seen, excluded.first_seen),
    last_seen  = greatest(public.visitors.last_seen, excluded.last_seen),
    is_test    = public.visitors.is_test or excluded.is_test;

-- Visitors that already existed before this ran get the flag too (arjun, test-script, tester, test-other).
update public.visitors set is_test = true where public.is_test_name(name_key) and not is_test;

-- 2. Point the old rows at their visitor (rows with no first name stay unlinked).
update public.qa_log      q set visitor_ref = v.id from public.visitors v where q.visitor_ref is null and v.name_key = lower(btrim(q.first_name));
update public.saved_items s set visitor_ref = v.id from public.visitors v where s.visitor_ref is null and v.name_key = lower(btrim(s.first_name));
update public.reports     r set visitor_ref = v.id from public.visitors v where r.visitor_ref is null and v.name_key = lower(btrim(r.first_name));

-- ---------- a readable summary for the Table Editor ----------
create or replace view public.visitor_activity with (security_invoker = true) as
select v.id, v.name, v.first_seen, v.last_seen, v.login_count, v.last_device_type, v.device_types, v.is_test, v.note,
       (select count(*) from public.qa_log q where q.visitor_ref = v.id and q.kind = 'ask')                                   as asks,
       (select count(*) from public.qa_log q where q.visitor_ref = v.id and q.kind = 'brief' and q.question not like '[web] %') as briefs,
       (select count(*) from public.qa_log q where q.visitor_ref = v.id and q.question like '[web] %')                          as web_research,
       (select count(*) from public.saved_items s where s.visitor_ref = v.id)                                                  as saved,
       (select count(*) from public.reports r where r.visitor_ref = v.id)                                                      as reports,
       (select count(*) from public.events e where e.visitor_ref = v.id and e.event_type = 'page_view')                         as page_views,
       (select count(distinct e.device_id) from public.events e where e.visitor_ref = v.id)                                    as devices
from public.visitors v;

revoke all on public.visitor_activity from anon, authenticated;

-- ---------- cleanup ----------
-- The login limit's keys are 'login:<ip>': raw IP addresses. They are short-lived counters (a 15-minute window), so
-- deleting them loses nothing; the next login attempt starts a fresh count.
delete from public.rate_limits where starts_with(key, 'login:');

commit;

-- ---------- check (one result: section / item / value) ----------
select 1 as n, 'visitors' as section, case when is_test then 'is_test = true' else 'is_test = false' end as item, count(*)::text as value
from public.visitors group by is_test
union all
select 1, 'visitors', 'total', count(*)::text from public.visitors
union all
select 2, 'rows linked to a visitor', 'qa_log', count(*) filter (where visitor_ref is not null) || ' of ' || count(*) from public.qa_log
union all
select 2, 'rows linked to a visitor', 'saved_items', count(*) filter (where visitor_ref is not null) || ' of ' || count(*) from public.saved_items
union all
select 2, 'rows linked to a visitor', 'reports', count(*) filter (where visitor_ref is not null) || ' of ' || count(*) from public.reports
union all
select 3, 'visitor_activity (first 5)', name, to_jsonb(a)::text from (select * from public.visitor_activity order by id limit 5) a
order by n, item;
