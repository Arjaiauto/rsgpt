-- Home page numbers, counted once by pipeline/site_stats.py (run it after any pipeline change) instead of on
-- every revalidation. One row (id = 1) with all counts as JSON; the site reads only this row.
-- Run in the Supabase SQL Editor.

create table if not exists public.site_stats (
    id          smallint primary key default 1 check (id = 1),
    stats       jsonb not null,
    counted_at  timestamptz not null default now()
);

comment on table public.site_stats is
    'Home page counts (verified rows, final run), written by pipeline/site_stats.py; one row, id = 1.';

-- Row Level Security on, no policies: only the service role (pipeline and site server) reads or writes it.
alter table public.site_stats enable row level security;
revoke all on table public.site_stats from anon, authenticated;
