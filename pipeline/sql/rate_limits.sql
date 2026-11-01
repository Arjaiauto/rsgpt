-- Ticket 24b: rate limits kept in the database, so they hold across every server instance (the old in-memory ones
-- reset on each cold start and were per instance). Run this in the Supabase SQL Editor.
-- Written only by the site's server (service role). Row Level Security on, no policies, and access revoked from the
-- anon and authenticated roles, so neither can read or write it.

create table if not exists public.rate_limits (
    key          text        not null,
    window_start timestamptz not null,
    count        integer     not null default 0,
    primary key (key, window_start)
);

comment on table public.rate_limits is
    'Fixed-window counters for the site''s rate limits: one row per key and window. Old windows are deleted now and then.';

alter table public.rate_limits enable row level security;
revoke all on table public.rate_limits from anon, authenticated;

-- Counts one try for p_key in the current window of p_window_s seconds and says whether it is still within p_max.
-- One INSERT ... ON CONFLICT DO UPDATE, so parallel requests can never both read the same count.
create or replace function public.take_rate_limit(p_key text, p_max integer, p_window_s integer)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
    ws timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_s) * p_window_s);
    c  integer;
begin
    insert into public.rate_limits as r (key, window_start, count)
    values (p_key, ws, 1)
    on conflict (key, window_start) do update set count = r.count + 1
    returning r.count into c;

    -- Housekeeping: about one call in fifty removes windows older than two days.
    if random() < 0.02 then
        delete from public.rate_limits where window_start < now() - interval '2 days';
    end if;

    return c <= p_max;
end;
$$;

revoke all on function public.take_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.take_rate_limit(text, integer, integer) to service_role;
