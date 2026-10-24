-- Hybrid search over public.chunks: vector similarity plus full-text rank, merged with
-- reciprocal rank fusion (RRF).
--
-- Run in the Supabase SQL Editor. Safe to run again (create or replace).
--
-- 1. Semantic side: the 100 chunks nearest to query_embedding by cosine distance, through
--    the HNSW index chunks_embedding_idx (vector_cosine_ops). hnsw.ef_search is raised to
--    100 for this function, because an HNSW scan returns at most ef_search rows (default 40).
-- 2. Keyword side: the 100 best chunks by ts_rank on text_search (the 'simple' config).
--    The question is split into words, filler words are dropped (English and Hinglish
--    function words, and raj / guest / episode, which every chunk has in its speaker
--    labels or header), and the rest are ORed, so a chunk needs only some of the words.
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
set hnsw.ef_search = 100
as $$
with semantic as (
    select n.id, row_number() over (order by n.distance, n.id) as rank
    from (
        select c.id, c.embedding <=> query_embedding as distance
        from public.chunks c
        where c.embedding is not null
        order by c.embedding <=> query_embedding
        limit 100
    ) n
),
words as (
    select string_agg(w, ' or ') as terms
    from (
        select distinct w
        from regexp_split_to_table(lower(coalesce(query_text, '')), '[[:space:][:punct:]]+') as w
        where length(w) > 1
          and w <> all (array[
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
    ) kept
),
keyword as (
    select k.id, row_number() over (order by k.rank_value desc, k.id) as rank
    from (
        select c.id, ts_rank(c.text_search, q.query) as rank_value
        from public.chunks c,
             (select websearch_to_tsquery('simple', terms) as query from words where terms is not null) q
        where c.text_search @@ q.query
        order by rank_value desc, c.id
        limit 100
    ) k
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
