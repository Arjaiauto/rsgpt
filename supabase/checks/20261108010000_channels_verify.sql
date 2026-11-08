-- Verify 20261108010000_channels.sql. Read-only: one SELECT, one jsonb row. Paste into the Supabase SQL editor.
-- Exact counts on the 17 tables (segments is about 1M rows: if the editor's statement timeout hits, run it a second time).
-- Pass when: all_ok is true (every table has rows_with_fo_channel = total_rows and a validated foreign key) and
-- remaining_anon_authenticated_table_grants is [].
with t(name) as (values ('episodes'),('chunks'),('segments'),('translation_segments'),('clips'),('guests'),('insights'),('chunk_terms'),('search_suggestions'),('thumbnail_features'),('site_stats'),('qa_log'),('saved_items'),('reports'),('answer_feedback'),('events'),('feedback')),
counts as (
  select t.name,
         (xpath('/row/total/text()', query_to_xml(format('select count(*) as total from public.%I', t.name), false, true, '')))[1]::text::bigint as total_rows,
         (xpath('/row/fo/text()',    query_to_xml(format('select count(*) filter (where channel_id = %L) as fo from public.%I', 'd1201d0f-475e-430e-9259-6d11c6111c40', t.name), false, true, '')))[1]::text::bigint as fo_rows,
         (select c.convalidated from pg_constraint c where c.conname = t.name || '_channel_id_fkey' and c.conrelid = ('public.' || t.name)::regclass) as fk_validated
  from t
)
select jsonb_build_object(
  'fo_channel_id', 'd1201d0f-475e-430e-9259-6d11c6111c40',
  'tables', (select coalesce(jsonb_agg(jsonb_build_object(
               'table', name, 'total_rows', total_rows, 'rows_with_fo_channel', fo_rows,
               'all_fo', total_rows = fo_rows, 'fk_validated', fk_validated) order by name), '[]'::jsonb) from counts),
  'all_ok', (select bool_and(total_rows = fo_rows and coalesce(fk_validated, false)) from counts),
  'channels_row', (select coalesce(jsonb_agg(to_jsonb(ch)), '[]'::jsonb) from public.channels ch),
  'indexes', (select coalesce(jsonb_agg(indexname order by indexname), '[]'::jsonb) from pg_indexes
              where schemaname = 'public' and indexname in ('chunks_channel_id_idx', 'episodes_channel_id_idx')),
  -- tables, views, materialized views: must be []
  'remaining_anon_authenticated_table_grants', (
    select coalesce(jsonb_agg(jsonb_build_object('relation', c.relname, 'grantee', r.rolname, 'privilege', a.privilege_type)
                              order by c.relname, r.rolname), '[]'::jsonb)
    from pg_class c
    cross join lateral aclexplode(c.relacl) a
    join pg_roles r on r.oid = a.grantee
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v', 'm', 'p', 'f')
      and r.rolname in ('anon', 'authenticated')
  ),
  -- informational: sequences are not revoked by this migration
  'sequence_grants_anon_authenticated_count', (
    select count(*) from pg_class c cross join lateral aclexplode(c.relacl) a join pg_roles r on r.oid = a.grantee
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'S' and r.rolname in ('anon', 'authenticated')
  ),
  'default_privileges_public', (
    select coalesce(jsonb_agg(jsonb_build_object('owner', d.defaclrole::regrole::text, 'objtype', d.defaclobjtype::text,
                                                 'acl', d.defaclacl::text[]) order by d.defaclrole::regrole::text, d.defaclobjtype), '[]'::jsonb)
    from pg_default_acl d where d.defaclnamespace = 'public'::regnamespace
  )
) as verify;
