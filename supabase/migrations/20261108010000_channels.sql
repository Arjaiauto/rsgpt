-- Multi-tenant step 1 (additive): public.channels, channel_id on content and user tables, grants cleanup.
-- NOT RUN YET. Written against supabase/migrations/20261108000000_baseline.sql (live dump, 2026-11-08).
--
-- Additive only: every new column has a constant default (Figuring Out), so the current site and pipeline keep working
-- without code changes. No primary key, unique constraint, check constraint, function or existing index is changed.
-- Reverse with 20261108010000_channels.rollback.sql; confirm with supabase/checks/20261108010000_channels_verify.sql.
--
-- Figuring Out channel id: d1201d0f-475e-430e-9259-6d11c6111c40  (fixed; used for the row, every column default, and the verify script)
-- Locks: ADD COLUMN with a constant default is a catalog-only change on Postgres 11+ (no rewrite). Each ADD CONSTRAINT ... NOT VALID
-- is instant; VALIDATE CONSTRAINT scans the table (segments, about 1M rows, takes the longest) without blocking writes.

begin;

set local lock_timeout = '15s';
set local statement_timeout = '10min';

-- ---------- 1. channels ----------
create table if not exists public.channels (
    id                 uuid primary key,
    slug               text not null unique,
    name               text not null,
    youtube_channel_id text unique,
    visibility         text not null default 'private' check (visibility in ('public', 'private')),
    active_run_id      text,
    settings           jsonb not null default '{}'::jsonb,
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now()
);
comment on table public.channels is
    'One row per creator channel (tenant). active_run_id is the extraction run the site shows (replaces ARCHIVE_RUN_ID in site/lib/archive-run.ts); settings holds per-channel copy and options.';

alter table public.channels enable row level security;   -- no policies, like every other table: only the service role reads it

-- ---------- 2. Figuring Out is channel #1 ----------
insert into public.channels (id, slug, name, youtube_channel_id, visibility, active_run_id, settings)
values (
    'd1201d0f-475e-430e-9259-6d11c6111c40',
    'figuring-out',
    'Figuring Out',
    'UCzwCEE_PchiBULMnAJqhGVg',
    'public',
    'extract-haiku-v5-20261023-011718',
    jsonb_build_object(
        'host_name',        'Raj Shamani',
        'host_short',       'Raj',
        'disclaimer',       'Unofficial project, not affiliated with Figuring Out. Every answer links to its source.',
        'default_language', 'hi'
    )
)
on conflict (id) do nothing;

-- ---------- 3. channel_id on 17 tables (constant default, then foreign key NOT VALID, then VALIDATE) ----------
-- Not added to: reviews, rate_limits, visitors.

alter table public.episodes add column if not exists channel_id uuid not null default 'd1201d0f-475e-430e-9259-6d11c6111c40';
alter table public.episodes add constraint episodes_channel_id_fkey foreign key (channel_id) references public.channels (id) not valid;
alter table public.episodes validate constraint episodes_channel_id_fkey;

alter table public.chunks add column if not exists channel_id uuid not null default 'd1201d0f-475e-430e-9259-6d11c6111c40';
alter table public.chunks add constraint chunks_channel_id_fkey foreign key (channel_id) references public.channels (id) not valid;
alter table public.chunks validate constraint chunks_channel_id_fkey;

alter table public.segments add column if not exists channel_id uuid not null default 'd1201d0f-475e-430e-9259-6d11c6111c40';
alter table public.segments add constraint segments_channel_id_fkey foreign key (channel_id) references public.channels (id) not valid;
alter table public.segments validate constraint segments_channel_id_fkey;

alter table public.translation_segments add column if not exists channel_id uuid not null default 'd1201d0f-475e-430e-9259-6d11c6111c40';
alter table public.translation_segments add constraint translation_segments_channel_id_fkey foreign key (channel_id) references public.channels (id) not valid;
alter table public.translation_segments validate constraint translation_segments_channel_id_fkey;

alter table public.clips add column if not exists channel_id uuid not null default 'd1201d0f-475e-430e-9259-6d11c6111c40';
alter table public.clips add constraint clips_channel_id_fkey foreign key (channel_id) references public.channels (id) not valid;
alter table public.clips validate constraint clips_channel_id_fkey;

alter table public.guests add column if not exists channel_id uuid not null default 'd1201d0f-475e-430e-9259-6d11c6111c40';
alter table public.guests add constraint guests_channel_id_fkey foreign key (channel_id) references public.channels (id) not valid;
alter table public.guests validate constraint guests_channel_id_fkey;

alter table public.insights add column if not exists channel_id uuid not null default 'd1201d0f-475e-430e-9259-6d11c6111c40';
alter table public.insights add constraint insights_channel_id_fkey foreign key (channel_id) references public.channels (id) not valid;
alter table public.insights validate constraint insights_channel_id_fkey;

alter table public.chunk_terms add column if not exists channel_id uuid not null default 'd1201d0f-475e-430e-9259-6d11c6111c40';
alter table public.chunk_terms add constraint chunk_terms_channel_id_fkey foreign key (channel_id) references public.channels (id) not valid;
alter table public.chunk_terms validate constraint chunk_terms_channel_id_fkey;

alter table public.search_suggestions add column if not exists channel_id uuid not null default 'd1201d0f-475e-430e-9259-6d11c6111c40';
alter table public.search_suggestions add constraint search_suggestions_channel_id_fkey foreign key (channel_id) references public.channels (id) not valid;
alter table public.search_suggestions validate constraint search_suggestions_channel_id_fkey;

alter table public.thumbnail_features add column if not exists channel_id uuid not null default 'd1201d0f-475e-430e-9259-6d11c6111c40';
alter table public.thumbnail_features add constraint thumbnail_features_channel_id_fkey foreign key (channel_id) references public.channels (id) not valid;
alter table public.thumbnail_features validate constraint thumbnail_features_channel_id_fkey;

alter table public.site_stats add column if not exists channel_id uuid not null default 'd1201d0f-475e-430e-9259-6d11c6111c40';
alter table public.site_stats add constraint site_stats_channel_id_fkey foreign key (channel_id) references public.channels (id) not valid;
alter table public.site_stats validate constraint site_stats_channel_id_fkey;

alter table public.qa_log add column if not exists channel_id uuid not null default 'd1201d0f-475e-430e-9259-6d11c6111c40';
alter table public.qa_log add constraint qa_log_channel_id_fkey foreign key (channel_id) references public.channels (id) not valid;
alter table public.qa_log validate constraint qa_log_channel_id_fkey;

alter table public.saved_items add column if not exists channel_id uuid not null default 'd1201d0f-475e-430e-9259-6d11c6111c40';
alter table public.saved_items add constraint saved_items_channel_id_fkey foreign key (channel_id) references public.channels (id) not valid;
alter table public.saved_items validate constraint saved_items_channel_id_fkey;

alter table public.reports add column if not exists channel_id uuid not null default 'd1201d0f-475e-430e-9259-6d11c6111c40';
alter table public.reports add constraint reports_channel_id_fkey foreign key (channel_id) references public.channels (id) not valid;
alter table public.reports validate constraint reports_channel_id_fkey;

alter table public.answer_feedback add column if not exists channel_id uuid not null default 'd1201d0f-475e-430e-9259-6d11c6111c40';
alter table public.answer_feedback add constraint answer_feedback_channel_id_fkey foreign key (channel_id) references public.channels (id) not valid;
alter table public.answer_feedback validate constraint answer_feedback_channel_id_fkey;

alter table public.events add column if not exists channel_id uuid not null default 'd1201d0f-475e-430e-9259-6d11c6111c40';
alter table public.events add constraint events_channel_id_fkey foreign key (channel_id) references public.channels (id) not valid;
alter table public.events validate constraint events_channel_id_fkey;

alter table public.feedback add column if not exists channel_id uuid not null default 'd1201d0f-475e-430e-9259-6d11c6111c40';
alter table public.feedback add constraint feedback_channel_id_fkey foreign key (channel_id) references public.channels (id) not valid;
alter table public.feedback validate constraint feedback_channel_id_fkey;

-- ---------- 4. the only two new indexes in this migration ----------
create index if not exists chunks_channel_id_idx   on public.chunks   (channel_id);
create index if not exists episodes_channel_id_idx on public.episodes (channel_id);

-- ---------- 5. grants cleanup: anon and authenticated lose all table and view access ----------
-- The baseline shows ALL on 9 tables for both roles (chunks, clips, episodes, feedback, guests, insights, reviews, segments,
-- translation_segments). Row Level Security is on without policies, so nothing was readable, but the grants are removed too.
-- The site and pipeline use the service role only (site/lib/db.ts). Function grants, service_role and postgres are not touched.
-- Existing sequences keep their grants (not requested); only the default for new ones changes.
revoke all on all tables in schema public from anon, authenticated;   -- tables, views and materialized views

-- New objects created by the current role (postgres) stop being granted to anon/authenticated. The baseline also has default
-- ACLs for supabase_admin; those belong to another role and cannot be changed from the SQL editor (not touched here).
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

commit;
