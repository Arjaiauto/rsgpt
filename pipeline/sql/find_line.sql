-- Ticket 21b: "Find a line" on the Ask page. Fuzzy-matches a remembered line against every transcript line
-- (public.segments, about 1M rows) with pg_trgm.
--
-- Run in the Supabase SQL Editor, one step at a time (select the step, click Run). Safe to run again: every statement
-- is "if not exists" / "create or replace". The editor runs a multi-statement query in a transaction, so nothing
-- here uses CREATE INDEX CONCURRENTLY (it cannot run in one). While an index builds, writes to public.segments wait,
-- so run Step 2 when the pipeline is not loading transcripts.

-- ---------- Step 1: the extension (instant) ----------
create extension if not exists pg_trgm with schema extensions;


-- ---------- Step 2: build both indexes (a minute or two on ~1M lines) ----------
set statement_timeout = 0;
set maintenance_work_mem = '256MB';

create index if not exists segments_text_roman_trgm_idx
    on public.segments using gin (text_roman extensions.gin_trgm_ops);

create index if not exists segments_text_original_trgm_idx
    on public.segments using gin (text_original extensions.gin_trgm_ops);


-- ---------- Step 3: the search function (instant) ----------
-- find_line(query_text, match_count): the best matching lines, best first.
--   similarity = the better of the Roman-script and original-script similarity (0 to 1).
-- Built not to time out on ~1M rows:
--   * "%" is the operator the GIN indexes answer (a bitmap OR of the two); similarity() is then computed only for
--     the lines it returns, never for all of them;
--   * the threshold starts high and steps down (0.55, then 0.42, then 0.32) and the search stops at the first step
--     that finds anything. A line that is really in the archive matches at the first step, where a query keeps only
--     lines sharing most of its trigrams (fast). Only a weak or made-up line reaches the low threshold, where common
--     words make the candidate list long (a query of everyday Hinglish words timed out in a single pass at 0.30);
--   * if even that step is cancelled by a statement timeout, the function returns nothing (the site says the line
--     was not found) instead of failing;
--   * the query is cut to 200 characters and must have 6 characters or more.
-- No grants to anon or authenticated: only the site's server (service role) calls it.

create or replace function public.find_line(query_text text, match_count int default 5)
returns table (
    segment_id  bigint,
    video_id    text,
    seq         integer,
    start_s     double precision,
    end_s       double precision,
    similarity  real
)
language plpgsql
stable
set search_path = public, extensions
as $$
declare
    q text := left(btrim(coalesce(query_text, '')), 200);
    t text;
begin
    if char_length(q) < 6 then
        return;
    end if;
    -- "%" is true above the threshold, so each is just under the 0.55 / 0.42 / 0.32 the site reads
    foreach t in array array['0.549', '0.419', '0.319'] loop
        perform set_config('pg_trgm.similarity_threshold', t, true);
        return query
        select s.id, s.video_id, s.seq, s.start_s, s.end_s,
               greatest(extensions.similarity(s.text_roman, q), extensions.similarity(s.text_original, q))::real as sim
        from public.segments s
        where s.text_roman operator(extensions.%) q
           or s.text_original operator(extensions.%) q
        order by sim desc, s.id
        limit least(greatest(match_count, 1), 20);
        if found then
            return;
        end if;
    end loop;
exception
    when query_canceled then
        return;
end;
$$;

revoke all on function public.find_line(text, int) from public, anon, authenticated;
grant execute on function public.find_line(text, int) to service_role;


-- ---------- Step 4: checks (each one runs as it is; run them one at a time) ----------
-- a) both indexes exist and are valid (indisvalid must be true, two rows):
select c.relname as index_name, i.indisvalid
from pg_index i join pg_class c on c.oid = i.indexrelid
where c.relname in ('segments_text_roman_trgm_idx', 'segments_text_original_trgm_idx');

-- b) the plan uses the indexes (look for "Bitmap Index Scan on segments_text_..._trgm_idx", not "Seq Scan"):
begin;
set local pg_trgm.similarity_threshold = 0.549;
explain select id from public.segments
where text_roman operator(extensions.%) 'He had like didnt they say that he had no chance of playing again'
   or text_original operator(extensions.%) 'He had like didnt they say that he had no chance of playing again';
rollback;

-- c) a real call (a line from the archive; the first row should be about 0.9):
select * from public.find_line('He had like didnt they say that he had no chance of playing again', 3);

-- d) a made-up line returns no rows:
select * from public.find_line('The purple elephant negotiated a quarterly dividend with the moon', 3);
