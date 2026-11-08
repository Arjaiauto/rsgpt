-- Cuepoint live-database audit: ONE read-only query, ONE row, ONE jsonb column "audit".
-- Paste everything from the first "with" down to the semicolon before "-- NOT MERGED" into the Supabase SQL editor.
--
-- Read-only: SELECTs on pg_catalog / information_schema / pg_indexes / pg_policies / pg_proc / storage / auth (counts only),
-- plus COUNT/SUM/MAX aggregates on app tables. No DDL, no DML, no SET. Function bodies are NOT returned (name, arguments and
-- return type only). Nothing from user tables (saved_items, qa_log, reports, answer_feedback, visitors) except counts.
--
-- Tables that may not exist yet (answer_feedback, feedback, reviews, visitors, saved_items, ...) are guarded with
-- to_regclass()/information_schema checks inside CASE, so a missing table or column shows as null / "missing", not an error.
-- Row counts in q01: exact when pg_class.reltuples < 2,000,000 (or never analysed), otherwise the estimate (labelled).

with
-- run a SELECT that returns one column "j" (jsonb) only if the table and required column exist; otherwise null
g(k, tbl, col, q) as (
  values
    ('saved_items',      'saved_items',      'first_name', $q$select jsonb_build_object('rows', count(*), 'distinct_names', count(distinct lower(first_name)), 'with_folder', count(folder), 'with_note', count(note)) as j from public.saved_items$q$),
    ('qa_log',           'qa_log',           'first_name', $q$select jsonb_build_object('rows', count(*), 'distinct_names', count(distinct lower(first_name)), 'null_first_name', count(*) filter (where first_name is null)) as j from public.qa_log$q$),
    ('qa_log_briefs',    'qa_log',           'kind',       $q$select jsonb_build_object('briefs', count(*) filter (where kind = 'brief'), 'asks', count(*) filter (where kind = 'ask')) as j from public.qa_log$q$),
    ('reports',          'reports',          'first_name', $q$select jsonb_build_object('rows', count(*), 'distinct_names', count(distinct lower(first_name))) as j from public.reports$q$),
    ('answer_feedback',  'answer_feedback',  'first_name', $q$select jsonb_build_object('rows', count(*), 'distinct_names', count(distinct lower(first_name))) as j from public.answer_feedback$q$),
    ('visitors',         'visitors',         'is_test',    $q$select jsonb_build_object('rows', count(*), 'test_visitors', count(*) filter (where is_test), 'seen_tour', count(*) filter (where tour_seen_at is not null)) as j from public.visitors$q$),
    ('visitors_basic',   'visitors',         'name_key',   $q$select jsonb_build_object('rows', count(*)) as j from public.visitors$q$),
    ('events',           'events',           'event_type', $q$select jsonb_build_object('rows', count(*)) as j from public.events$q$),
    ('feedback',         'feedback',         'page',       $q$select jsonb_build_object('rows', count(*)) as j from public.feedback$q$),
    ('reviews',          'reviews',          'verdict',    $q$select jsonb_build_object('rows', count(*)) as j from public.reviews$q$),
    ('chunk_terms',      'chunk_terms',      'chunk_count',$q$select jsonb_build_object('words', count(*), 'max_chunk_count', max(chunk_count)) as j from public.chunk_terms$q$),
    ('search_suggestions','search_suggestions','kind',     $q$select jsonb_build_object('rows', count(*), 'by_kind', (select jsonb_object_agg(kind, n) from (select kind, count(*) n from public.search_suggestions group by kind) s)) as j from public.search_suggestions$q$),
    ('site_stats',       'site_stats',       'stats',      $q$select jsonb_build_object('rows', count(*), 'counted_at', max(counted_at)) as j from public.site_stats$q$),
    ('thumbnail_features','thumbnail_features','features', $q$select jsonb_build_object('rows', count(*)) as j from public.thumbnail_features$q$)
),
guarded as (
  select g.k,
         case
           when to_regclass('public.' || g.tbl) is null then jsonb_build_object('status', 'table missing')
           when not exists (select 1 from information_schema.columns c
                            where c.table_schema = 'public' and c.table_name = g.tbl and c.column_name = g.col)
                then jsonb_build_object('status', 'column missing: ' || g.col)
           else (xpath('/row/j/text()', query_to_xml(g.q, false, true, '')))[1]::text::jsonb
         end as v
  from g
),
-- q01: every public table / view with RLS flag and a row count (exact under 2M rows, else estimate)
rel as (
  select c.oid, c.relname, c.relkind::text as relkind, c.relrowsecurity as rls_on, c.reltuples::bigint as reltuples_est
  from pg_class c
  where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v', 'm', 'p')
),
rel_counts as (
  select r.*,
         case when r.relkind = 'r' and r.reltuples_est < 2000000
              then (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', r.relname), false, true, '')))[1]::text::bigint
         end as exact_rows
  from rel r
)
select jsonb_build_object(

  'q01_tables', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'name', relname,
             'kind', case relkind when 'r' then 'table' when 'v' then 'view' when 'm' then 'matview' else relkind end,
             'rls_on', rls_on,
             'rows', coalesce(exact_rows, case when relkind = 'r' then reltuples_est end),
             'rows_kind', case when relkind <> 'r' then 'n/a' when exact_rows is not null then 'exact' else 'estimate' end
           ) order by relname), '[]'::jsonb)
    from rel_counts
  ),

  'q02_columns', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'table', table_name, 'pos', ordinal_position, 'column', column_name, 'type', data_type,
             'udt', udt_name, 'nullable', is_nullable, 'default', column_default
           ) order by table_name, ordinal_position), '[]'::jsonb)
    from information_schema.columns
    where table_schema = 'public'
  ),

  'q03_constraints', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'table', conrelid::regclass::text, 'name', conname, 'type', contype::text,
             'definition', pg_get_constraintdef(oid)
           ) order by conrelid::regclass::text, contype, conname), '[]'::jsonb)
    from pg_constraint
    where connamespace = 'public'::regnamespace
  ),

  'q04_all_functions', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'name', p.proname, 'args', pg_get_function_identity_arguments(p.oid),
             'returns', pg_get_function_result(p.oid), 'security_definer', p.prosecdef,
             'config', to_jsonb(p.proconfig)
           ) order by p.proname, pg_get_function_identity_arguments(p.oid)), '[]'::jsonb)
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
  ),

  'q04_hybrid_search_scoped_exists', jsonb_build_object(
    'hybrid_search',        exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'hybrid_search'),
    'hybrid_search_scoped', exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'hybrid_search_scoped'),
    'find_line',            exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'find_line'),
    'near_words',           exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'near_words'),
    'set_answer_feedback',  exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'set_answer_feedback'),
    'take_rate_limit',      exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'take_rate_limit'),
    'set_clip_guest_share', exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'set_clip_guest_share'),
    'record_login',         exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'record_login')
  ),

  -- signatures only (no bodies): compare with pipeline/sql/search_v3.sql, hybrid_search_scoped.sql, find_line.sql, search_v2.sql
  'q05_search_function_signatures', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'name', p.proname, 'args', pg_get_function_identity_arguments(p.oid),
             'returns', pg_get_function_result(p.oid), 'config', to_jsonb(p.proconfig)
           ) order by p.proname), '[]'::jsonb)
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('hybrid_search', 'hybrid_search_scoped', 'find_line', 'near_words')
  ),

  'q06_indexes', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'table', i.tablename, 'index', i.indexname,
             'size', pg_size_pretty(pg_relation_size((quote_ident(i.schemaname) || '.' || quote_ident(i.indexname))::regclass)),
             'definition', i.indexdef
           ) order by i.tablename, i.indexname), '[]'::jsonb)
    from pg_indexes i
    where i.schemaname = 'public'
  ),

  'q07_policies', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'table', tablename, 'policy', policyname, 'roles', to_jsonb(roles), 'cmd', cmd,
             'using', qual, 'with_check', with_check
           ) order by tablename, policyname), '[]'::jsonb)
    from pg_policies
    where schemaname = 'public'
  ),

  'q07_rls_flags', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'table', relname, 'rls_enabled', relrowsecurity, 'rls_forced', relforcerowsecurity
           ) order by relname), '[]'::jsonb)
    from pg_class
    where relnamespace = 'public'::regnamespace and relkind = 'r'
  ),

  'q08_table_grants_anon_authenticated', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'table', table_name, 'grantee', grantee, 'privilege', privilege_type
           ) order by table_name, grantee, privilege_type), '[]'::jsonb)
    from information_schema.role_table_grants
    where table_schema = 'public' and grantee in ('anon', 'authenticated')
  ),

  'q08_function_grants_public_anon_authenticated', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'function', routine_name, 'grantee', grantee, 'privilege', privilege_type
           ) order by routine_name, grantee), '[]'::jsonb)
    from information_schema.routine_privileges
    where routine_schema = 'public' and grantee in ('anon', 'authenticated', 'PUBLIC')
  ),

  'q09_triggers', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'table', event_object_table, 'trigger', trigger_name, 'timing', action_timing,
             'event', event_manipulation, 'action', action_statement
           ) order by event_object_table, trigger_name), '[]'::jsonb)
    from information_schema.triggers
    where trigger_schema = 'public'
  ),

  'q10_extensions', (
    select coalesce(jsonb_agg(jsonb_build_object('name', extname, 'version', extversion) order by extname), '[]'::jsonb)
    from pg_extension
  ),

  'q10_settings', jsonb_build_object(
    'server_version',    current_setting('server_version'),
    'hnsw_ef_search',    current_setting('hnsw.ef_search', true),           -- null if pgvector's setting is not loaded in this session
    'statement_timeout', current_setting('statement_timeout')
  ),

  -- q11: exact (episodes ~500 rows, chunks ~35k, insights/guests small enough to count exactly)
  'q11_archive_scale', (
    select jsonb_build_object(
      'episodes',                (select count(*) from public.episodes),
      'transcribed',             (select count(*) from public.episodes where status = 'transcribed'),
      'avg_minutes_transcribed', (select round(avg(duration_seconds) / 60.0, 1) from public.episodes where status = 'transcribed'),
      'archive_hours_transcribed_exact', (select round(sum(duration_seconds) / 3600.0, 2) from public.episodes where status = 'transcribed'),
      'archive_hours_all_episodes_exact', (select round(sum(duration_seconds) / 3600.0, 2) from public.episodes),
      'chunks',                  (select count(*) from public.chunks),
      'guest_run_ids',           (select count(distinct run_id) from public.guests),
      'insight_run_ids',         (select count(distinct run_id) from public.insights)
    )
  ),

  'q11_caption_language', (
    select coalesce(jsonb_agg(jsonb_build_object('caption_language', caption_language, 'episodes', n, 'hours', hrs) order by n desc), '[]'::jsonb)
    from (select caption_language, count(*) n, round(sum(duration_seconds) / 3600.0, 2) hrs
          from public.episodes where status = 'transcribed' group by caption_language) s
  ),

  'q12_runs_insights', (
    select coalesce(jsonb_agg(jsonb_build_object('run_id', run_id, 'verified', v, 'total', t) order by t desc), '[]'::jsonb)
    from (select run_id, count(*) filter (where verified) v, count(*) t from public.insights group by run_id) s
  ),
  'q12_runs_guests', (
    select coalesce(jsonb_agg(jsonb_build_object('run_id', run_id, 'verified', v, 'total', t) order by t desc), '[]'::jsonb)
    from (select run_id, count(*) filter (where verified) v, count(*) t from public.guests group by run_id) s
  ),
  'q12_runs_clips', (
    select coalesce(jsonb_agg(jsonb_build_object('run_id', run_id, 'verified', v, 'total', t) order by t desc), '[]'::jsonb)
    from (select run_id, count(*) filter (where verified) v, count(*) t from public.clips group by run_id) s
  ),

  -- q13: same person across episodes (verified guest rows; counts only)
  'q13_guests_shared_people', (
    select jsonb_build_object(
      'distinct_guest_keys',   count(distinct guest_key),
      'guest_rows',            count(*),
      'rows_with_photo',       count(*) filter (where photo_url is not null),
      'rows_manual_links',     count(*) filter (where link_source = 'manual'),
      'rows_auto_links',       count(*) filter (where link_source = 'auto'),
      'guest_keys_in_2plus_episodes', (select count(*) from (select guest_key from public.guests where verified and guest_key is not null group by guest_key having count(distinct video_id) > 1) m)
    )
    from public.guests where verified
  ),

  -- q14: counts only from per-user tables (no names, no text); "table missing" if a *.sql script was never run
  'q14_saved_items',     (select v from guarded where k = 'saved_items'),
  'q14_qa_log',          (select v from guarded where k = 'qa_log'),
  'q14_qa_log_kinds',    (select v from guarded where k = 'qa_log_briefs'),
  'q14_reports',         (select v from guarded where k = 'reports'),
  'q14_answer_feedback', (select v from guarded where k = 'answer_feedback'),
  'q14_visitors',        (select coalesce((select v from guarded where k = 'visitors' and v ? 'rows'), (select v from guarded where k = 'visitors_basic'))),
  'q14_events',          (select v from guarded where k = 'events'),

  'q15_feedback_table',  (select v from guarded where k = 'feedback'),
  'q15_reviews_table',   (select v from guarded where k = 'reviews'),

  'q16_chunk_terms',     (select v from guarded where k = 'chunk_terms'),
  'q16_chunks_planner_estimate', (select reltuples::bigint from pg_class where oid = 'public.chunks'::regclass),
  'q16_search_suggestions', (select v from guarded where k = 'search_suggestions'),

  'q17_storage_buckets', (
    select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'public', public) order by name), '[]'::jsonb)
    from storage.buckets
  ),
  'q17_storage_object_counts', (
    select coalesce(jsonb_agg(jsonb_build_object('bucket', bucket_id, 'objects', n) order by bucket_id), '[]'::jsonb)
    from (select bucket_id, count(*) n from storage.objects group by bucket_id) s
  ),

  -- q19: sizes (what a per-channel partition or index would cost)
  'q19_table_sizes', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'table', relname,
             'total', pg_size_pretty(pg_total_relation_size(oid)),
             'heap',  pg_size_pretty(pg_relation_size(oid)),
             'total_bytes', pg_total_relation_size(oid)
           ) order by pg_total_relation_size(oid) desc), '[]'::jsonb)
    from pg_class
    where relnamespace = 'public'::regnamespace and relkind = 'r'
  ),

  -- q20: auth readiness (count only; providers are in Dashboard > Authentication)
  'q20_auth_users_count', (select count(*) from auth.users),

  'q21_site_stats_row',  (select v from guarded where k = 'site_stats'),
  'q21_thumbnail_features', (select v from guarded where k = 'thumbnail_features'),

  'meta', jsonb_build_object('generated_at', now(), 'database', current_database(), 'note', 'q18 and the per-episode transcript-source query are NOT merged; see the bottom of docs/audit_live_check.sql')

) as audit;


-- =====================================================================================================================
-- NOT MERGED (run separately, each on its own, only if you want them)
-- =====================================================================================================================

-- q18: EXPLAIN ANALYZE actually executes the query and cannot be returned as a column of the combined query. Read-only.
-- Look for "Index Scan using chunks_embedding_idx" (HNSW used) and the execution time.
explain (analyze, buffers)
select id from public.chunks order by embedding <=> (select embedding from public.chunks limit 1) limit 40;

-- q11 (third query): which transcript source each episode used (youtube_auto vs groq vs sarvam). Not merged because
-- "select distinct video_id, source" scans all ~1M segment rows and could hit Supabase's 8 s statement timeout inside the
-- combined query. Run alone; if it times out, run it with a filter on a range of video_ids.
select source, count(*) as episodes
from (select distinct video_id, source from public.segments) s
group by source
order by episodes desc;
