-- Search v2: hybrid search over public.chunks whose keyword side uses only rare words.
--
-- Run in the Supabase SQL Editor, in order:
--   Step 1 to 3 together (safe to run again).
--   Step 4 one query at a time, to check the plan and the timing.
-- After chunks are reloaded, run Step 2 again so the word counts stay current.
--
-- Why: v1 ORed every non-filler word of the question, and common words ("first", "round",
-- "india", "start") matched thousands of chunks; ranking them all took past the 8 s
-- statement timeout. v2 keeps only the 3 rarest query words that appear in under 5% of
-- chunks, counted in public.chunk_terms. Names, brands and specific terms stay; meaning is
-- left to the vector side.
--
-- This replaces pipeline/sql/hybrid_search.sql (same function name and arguments).


-- ---------- Step 1: chunk_terms table ----------

create table if not exists public.chunk_terms (
    word         text primary key,
    chunk_count  integer not null
);
comment on table public.chunk_terms is
    'Number of chunks whose text_search contains each word (ts_stat over chunks). hybrid_search uses it to keep only rare query words. Refill after chunks are reloaded.';
alter table public.chunk_terms enable row level security;
revoke all on table public.chunk_terms from anon, authenticated;


-- ---------- Step 2: fill chunk_terms (again after chunks are reloaded) ----------

set statement_timeout = '10min';
truncate public.chunk_terms;
insert into public.chunk_terms (word, chunk_count)
select word, ndoc from ts_stat('select text_search from public.chunks');
analyze public.chunk_terms;
analyze public.chunks;  -- keeps pg_class.reltuples (the chunk count used for the 5% limit) current


-- ---------- Step 3: hybrid_search ----------
--
-- 1. Semantic side: a plain "order by c.embedding <=> query_embedding limit 40" on chunks, so
--    it runs as an index scan on chunks_embedding_idx (HNSW, vector_cosine_ops). Rows are
--    numbered in an outer query. 40 because an HNSW scan returns at most hnsw.ef_search rows
--    (default 40), which hosted Supabase does not allow setting on a function.
-- 2. Keyword side: the question is split into lexemes by the same parser as text_search
--    (to_tsvector 'simple'); filler words are dropped (English and Hinglish function words,
--    and raj / guest / episode, in every chunk's labels or header); of the rest, only words
--    in under 5% of chunks are kept, the 3 rarest of them, ORed. The 100 best chunks by
--    ts_rank are taken.
-- 3. RRF: score = sum over the two sides of 1 / (60 + rank), rank starting at 1; a chunk
--    found by one side only gets that side's term. The top match_count are returned.
--
-- Only the service role may call it (the pipeline scripts and the website's server code).

create or replace function public.hybrid_search(
    query_embedding  extensions.vector(512),
    query_text       text,
    match_count      int default 20
)
returns table (
    id            bigint,
    video_id      text,
    start_s       double precision,
    end_s         double precision,
    text          text,
    published_at  timestamptz,
    score         double precision
)
language sql
stable
set search_path = public, extensions
as $$
with semantic_hits as materialized (
    select c.id, c.embedding <=> query_embedding as distance
    from public.chunks c
    order by c.embedding <=> query_embedding
    limit 40
),
semantic as (
    select h.id, row_number() over (order by h.distance, h.id) as rank
    from semantic_hits h
),
total as (
    -- chunk count from the planner statistics (instant); a real count if never analyzed
    select coalesce(nullif(greatest(cl.reltuples, 0), 0), (select count(*) from public.chunks)) as chunks
    from pg_class cl
    where cl.oid = 'public.chunks'::regclass
),
words as (
    select distinct v.lexeme as word
    from unnest(to_tsvector('simple', coalesce(query_text, ''))) as v
    where length(v.lexeme) > 1
      and v.lexeme <> all (array[
          -- English
          'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did',
          'have', 'has', 'had', 'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how',
          'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them', 'my', 'your', 'his',
          'its', 'our', 'their', 'this', 'that', 'these', 'those', 'of', 'in', 'on', 'at', 'to', 'for',
          'from', 'by', 'with', 'about', 'as', 'into', 'over', 'after', 'before', 'and', 'or', 'but',
          'not', 'no', 'so', 'if', 'then', 'than', 'there', 'here', 'can', 'could', 'would', 'should',
          'will', 'shall', 'may', 'might', 'must', 'just', 'also', 'very', 'more', 'most', 'some', 'any',
          'all', 'each', 'every', 'other', 'such', 'only', 'own', 'same', 'too', 'up', 'down', 'out',
          'off', 'again', 'once', 'say', 'says', 'said', 'talk', 'talks', 'talked', 'usually', 'ever',
          -- Hinglish
          'ka', 'ke', 'ki', 'ko', 'kya', 'hai', 'hain', 'tha', 'thi', 'the', 'mein', 'me', 'pe', 'par',
          'se', 'ne', 'aur', 'ya', 'bhi', 'to', 'toh', 'kaun', 'kaunse', 'kaise', 'kab', 'kyun', 'kahan',
          'ye', 'yeh', 'woh', 'wo', 'baare', 'baat', 'ji', 'ek', 'koi', 'kuch', 'jo',
          -- in every chunk's labels or header
          'raj', 'guest', 'guests', 'episode', 'episodes', 'show'
      ])
),
rare as (
    select w.word
    from words w
    join public.chunk_terms t on t.word = w.word
    cross join total
    where t.chunk_count < 0.05 * total.chunks
    order by t.chunk_count, w.word
    limit 3
),
tsq as (
    select websearch_to_tsquery('simple', string_agg(r.word, ' or ')) as q
    from rare r
    having count(*) > 0
),
keyword_hits as (
    select c.id, ts_rank(c.text_search, tsq.q) as rank_value
    from public.chunks c
    cross join tsq
    where c.text_search @@ tsq.q
    order by rank_value desc, c.id
    limit 100
),
keyword as (
    select k.id, row_number() over (order by k.rank_value desc, k.id) as rank
    from keyword_hits k
),
fused as (
    select coalesce(s.id, k.id) as id,
           coalesce(1.0 / (60 + s.rank), 0) + coalesce(1.0 / (60 + k.rank), 0) as score
    from semantic s
    full outer join keyword k on k.id = s.id
)
select c.id, c.video_id, c.start_s, c.end_s, c.text, c.published_at, f.score::double precision
from fused f
join public.chunks c on c.id = f.id
order by f.score desc, c.id
limit match_count;
$$;

revoke execute on function public.hybrid_search(extensions.vector, text, int) from public, anon, authenticated;
grant execute on function public.hybrid_search(extensions.vector, text, int) to service_role;


-- ---------- Step 4: checks (run one at a time) ----------

-- 4a. The semantic part alone, with the stored embedding of the first chunk as the query
--     vector. The plan should show "Index Scan using chunks_embedding_idx". The vector is a
--     scalar subquery so it is computed first (InitPlan) and can drive the index; a join
--     value could not.
explain (analyze, buffers)
select c.id, c.embedding <=> (select embedding from public.chunks order by id limit 1) as distance
from public.chunks c
order by c.embedding <=> (select embedding from public.chunks order by id limit 1)
limit 40;

-- 4b. Which words the keyword side would keep for a question (the 3 rarest under 5%).
select t.word, t.chunk_count,
       round((100.0 * t.chunk_count
              / (select reltuples from pg_class where oid = 'public.chunks'::regclass))::numeric, 1) as pct_of_chunks
from unnest(to_tsvector('simple', 'What have founders on the show said about raising their first round?')) v
join public.chunk_terms t on t.word = v.lexeme
order by t.chunk_count;

-- 4c. The whole function on the slowest v1 question, timed.
explain (analyze, buffers)
select id, score
from public.hybrid_search((select embedding from public.chunks order by id limit 1),
                          'What have founders on the show said about raising their first round?', 5);
