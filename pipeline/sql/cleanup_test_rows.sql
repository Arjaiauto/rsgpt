-- Ticket 24b: test rows left behind by earlier checks. Run in the Supabase SQL Editor.
-- Counts before (read through the API on 2026-11-01): qa_log 166 rows match (120 'Tester' in any case + 46 with no
-- first name) of 214; reports 1 row of 1.
delete from public.qa_log where lower(first_name) = 'tester' or first_name is null;
delete from public.reports where note = 'Report an error test';
