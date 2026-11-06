-- Ticket 28d: public.hybrid_search_scoped, the Ask search limited to a set of episodes (Ask within a scope: guest,
-- topic, year, language). NOT RUN YET. Run in the Supabase SQL Editor (safe to run twice: create or replace).
--
-- Same scoring as public.hybrid_search (search_v3.sql): semantic rank + keyword rank, fused with RRF (k = 60), at most
-- `per_episode` chunks per episode, then the top `match_count`. Two differences:
--
--   1. Only chunks of `video_ids` count, on both the semantic and the keyword side. A NULL or empty list matches nothing.
--   2. Two ways to rank the semantic side, chosen by the caller with `exact_scan`:
--        true  (default)  every chunk in scope is compared with the question: exact, best for small and medium scopes
--                         (a guest, a topic, a year). Cost grows with the number of chunks in scope.
--        false            the HNSW index gives the 200 nearest chunks of the whole archive, then the ones in scope are
--                         kept. Fast whatever the scope size; only good for big scopes (a language, a year), where most
--                         of those 200 are in scope.
--      The site picks one per question (site/lib/ask/config.ts, ASK.scopeExactMaxChunks).
--
-- Unchanged from search_v3.sql: filler words, the 3 rarest words under 5% of chunks (counted over the whole archive),
-- the top 100 by ts_rank, RRF with k = 60, the same output columns. public.hybrid_search itself is not touched.

begin;

create or replace function public.hybrid_search_scoped(
    query_embedding  extensions.vector(512),
    query_text       text,
    match_count      int default 20,
    video_ids        text[] default null,
    per_episode      int default 2,
    exact_scan       boolean default true
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
-- The index path asks HNSW for 200 neighbours; HNSW returns at most ef_search rows.
set hnsw.ef_search = 200
set search_path = public, extensions
as $$
with exact_hits as materialized (
    -- every chunk in scope, compared exactly; only read when exact_scan is true. "+ 0" keeps the planner from ordering
    -- by the HNSW index here (an index scan filtered to a small scope would return fewer than 40 rows).
    select c.id, (c.embedding <=> query_embedding) + 0 as distance
    from public.chunks c
    where exact_scan and c.video_id = any (video_ids)
    order by 2, c.id
    limit 40
),
index_near as materialized (
    -- the 200 nearest chunks of the whole archive by the HNSW index; only read when exact_scan is false
    select c.id, c.video_id, c.embedding <=> query_embedding as distance
    from public.chunks c
    where not exact_scan
    order by c.embedding <=> query_embedding
    limit 200
),
index_hits as (
    select n.id, n.distance
    from index_near n
    where n.video_id = any (video_ids)
    order by n.distance, n.id
    limit 40
),
semantic as (
    select h.id, row_number() over (order by h.distance, h.id) as rank
    from (select e.id, e.distance from exact_hits e union all select i.id, i.distance from index_hits i) h
),
total as (
    select coalesce(nullif(greatest(cl.reltuples, 0), 0), (select count(*) from public.chunks)) as chunks
    from pg_class cl
    where cl.oid = 'public.chunks'::regclass
),
lexemes as (
    select v.lexeme
    from unnest(to_tsvector('simple', coalesce(query_text, ''))) as v
),
question_language as (
    select not (
        coalesce(query_text, '') ~ '[ऀ-ॿ]'
        or exists (select 1 from lexemes l where l.lexeme = any (array[
            'ka', 'ke', 'ki', 'ko', 'kya', 'hai', 'hain', 'mein', 'aur', 'ne', 'pe', 'se', 'kaun', 'kaunse',
            'kaise', 'kyun', 'kahan', 'kab', 'baare', 'baat', 'nahi', 'kitna', 'kitne', 'kaisa', 'wala',
            'wale', 'bhi', 'toh', 'tha', 'thi', 'raha', 'rahe', 'karte', 'karna', 'liye', 'apne', 'unka', 'unke'
        ]))
    ) as english
),
words as (
    select distinct l.lexeme as word
    from lexemes l
    cross join question_language
    where (length(l.lexeme) >= 3
           or (question_language.english and l.lexeme = any (array['ai', 'ev', 'vc', 'ipo', 'd2c', 'b2b', 'upi', 'gst'])))
      and l.lexeme <> all (array[
          'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did',
          'have', 'has', 'had', 'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how',
          'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them', 'my', 'your', 'his',
          'its', 'our', 'their', 'this', 'that', 'these', 'those', 'of', 'in', 'on', 'at', 'to', 'for',
          'from', 'by', 'with', 'about', 'as', 'into', 'over', 'after', 'before', 'and', 'or', 'but',
          'not', 'no', 'so', 'if', 'then', 'than', 'there', 'here', 'can', 'could', 'would', 'should',
          'will', 'shall', 'may', 'might', 'must', 'just', 'also', 'very', 'more', 'most', 'some', 'any',
          'all', 'each', 'every', 'other', 'such', 'only', 'own', 'same', 'too', 'up', 'down', 'out',
          'off', 'again', 'once', 'say', 'says', 'said', 'talk', 'talks', 'talked', 'usually', 'ever',
          'ka', 'ke', 'ki', 'ko', 'kya', 'hai', 'hain', 'tha', 'thi', 'the', 'mein', 'me', 'pe', 'par',
          'se', 'ne', 'aur', 'ya', 'bhi', 'to', 'toh', 'kaun', 'kaunse', 'kaise', 'kab', 'kyun', 'kahan',
          'ye', 'yeh', 'woh', 'wo', 'baare', 'baat', 'ji', 'ek', 'koi', 'kuch', 'jo',
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
    where c.text_search @@ tsq.q and c.video_id = any (video_ids)
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
),
per_episode_rank as (
    select c.id, c.video_id, c.start_s, c.end_s, c.text, c.published_at, f.score,
           row_number() over (partition by c.video_id order by f.score desc, c.id) as in_episode
    from fused f
    join public.chunks c on c.id = f.id
)
select p.id, p.video_id, p.start_s, p.end_s, p.text, p.published_at, p.score::double precision
from per_episode_rank p
where p.in_episode <= greatest(per_episode, 1)
order by p.score desc, p.id
limit match_count;
$$;

revoke execute on function public.hybrid_search_scoped(extensions.vector, text, int, text[], int, boolean) from public, anon, authenticated;
grant execute on function public.hybrid_search_scoped(extensions.vector, text, int, text[], int, boolean) to service_role;

commit;

-- ---------- check ----------
select p.proname, pg_get_function_identity_arguments(p.oid) as arguments, p.proconfig as settings
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'hybrid_search_scoped';
