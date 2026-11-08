-- Rollback of 20261108010000_channels.sql. NOT RUN YET.
-- Drops the two indexes, the foreign keys and channel_id columns, and public.channels, then restores the grants exactly as
-- they are in supabase/migrations/20261108000000_baseline.sql.
-- Warning: this deletes the channel_id values. Run it only before a second channel exists (or accept losing the tags).

begin;

set local lock_timeout = '15s';
set local statement_timeout = '10min';

drop index if exists public.chunks_channel_id_idx;
drop index if exists public.episodes_channel_id_idx;

alter table public.episodes drop constraint if exists episodes_channel_id_fkey;
alter table public.episodes drop column if exists channel_id;

alter table public.chunks drop constraint if exists chunks_channel_id_fkey;
alter table public.chunks drop column if exists channel_id;

alter table public.segments drop constraint if exists segments_channel_id_fkey;
alter table public.segments drop column if exists channel_id;

alter table public.translation_segments drop constraint if exists translation_segments_channel_id_fkey;
alter table public.translation_segments drop column if exists channel_id;

alter table public.clips drop constraint if exists clips_channel_id_fkey;
alter table public.clips drop column if exists channel_id;

alter table public.guests drop constraint if exists guests_channel_id_fkey;
alter table public.guests drop column if exists channel_id;

alter table public.insights drop constraint if exists insights_channel_id_fkey;
alter table public.insights drop column if exists channel_id;

alter table public.chunk_terms drop constraint if exists chunk_terms_channel_id_fkey;
alter table public.chunk_terms drop column if exists channel_id;

alter table public.search_suggestions drop constraint if exists search_suggestions_channel_id_fkey;
alter table public.search_suggestions drop column if exists channel_id;

alter table public.thumbnail_features drop constraint if exists thumbnail_features_channel_id_fkey;
alter table public.thumbnail_features drop column if exists channel_id;

alter table public.site_stats drop constraint if exists site_stats_channel_id_fkey;
alter table public.site_stats drop column if exists channel_id;

alter table public.qa_log drop constraint if exists qa_log_channel_id_fkey;
alter table public.qa_log drop column if exists channel_id;

alter table public.saved_items drop constraint if exists saved_items_channel_id_fkey;
alter table public.saved_items drop column if exists channel_id;

alter table public.reports drop constraint if exists reports_channel_id_fkey;
alter table public.reports drop column if exists channel_id;

alter table public.answer_feedback drop constraint if exists answer_feedback_channel_id_fkey;
alter table public.answer_feedback drop column if exists channel_id;

alter table public.events drop constraint if exists events_channel_id_fkey;
alter table public.events drop column if exists channel_id;

alter table public.feedback drop constraint if exists feedback_channel_id_fkey;
alter table public.feedback drop column if exists channel_id;

drop table if exists public.channels;

-- Grants as in the baseline dump: ALL on these tables for anon and authenticated (baseline lines 2217-2447).
grant all on table public.chunks to anon;
grant all on table public.chunks to authenticated;
grant all on table public.clips to anon;
grant all on table public.clips to authenticated;
grant all on table public.episodes to anon;
grant all on table public.episodes to authenticated;
grant all on table public.feedback to anon;
grant all on table public.feedback to authenticated;
grant all on table public.guests to anon;
grant all on table public.guests to authenticated;
grant all on table public.insights to anon;
grant all on table public.insights to authenticated;
grant all on table public.reviews to anon;
grant all on table public.reviews to authenticated;
grant all on table public.segments to anon;
grant all on table public.segments to authenticated;
grant all on table public.translation_segments to anon;
grant all on table public.translation_segments to authenticated;

-- Default privileges for objects created by postgres (baseline lines 2481-2482 and 2521-2522).
alter default privileges for role postgres in schema public grant all on sequences to anon;
alter default privileges for role postgres in schema public grant all on sequences to authenticated;
alter default privileges for role postgres in schema public grant all on tables to anon;
alter default privileges for role postgres in schema public grant all on tables to authenticated;

commit;
