-- Search v3: public.hybrid_search with two fixes over v2 (pipeline/sql/search_v2.sql).
--
-- Run in the Supabase SQL Editor (create or replace; same name, arguments and output, so
-- the grants stay as they are and are set again below). No table changes: chunk_terms
-- from search_v2.sql Step 1-2 is used as it is. search_v2.sql Step 4 checks still apply.
--
-- 1. At most 2 chunks per episode: after fusion, each episode keeps its 2 best chunks by
--    fused score; the top match_count of those are returned.
-- 2. Keyword side: query words under 3 letters are ignored, except ai, ev, vc, ipo, d2c, b2b,
--    upi, gst, which are kept only when the question is in English: no Devanagari and no
--    Hinglish function word (ka, ke, ki, kya, hai, mein, aur, ...). In Hinglish transcripts
--    "ai" is also an ordinary word (an interjection), so it matched unrelated chunks.
--
-- Unchanged from v2: the semantic side (plain HNSW scan, top 40), filler words, the 3
-- rarest words under 5% of chunks, the top 100 by ts_rank, RRF with k = 60.

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
lexemes as (
    select v.lexeme
    from unnest(to_tsvector('simple', coalesce(query_text, ''))) as v
),
question_language as (
    -- English unless the question has Devanagari or a Hinglish function word
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
           -- short terms kept only for English questions; in Hinglish text "ai" etc. are also ordinary words
           or (question_language.english and l.lexeme = any (array['ai', 'ev', 'vc', 'ipo', 'd2c', 'b2b', 'upi', 'gst'])))
      and l.lexeme <> all (array[
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
),
per_episode as (
    select c.id, c.video_id, c.start_s, c.end_s, c.text, c.published_at, f.score,
           row_number() over (partition by c.video_id order by f.score desc, c.id) as in_episode
    from fused f
    join public.chunks c on c.id = f.id
)
select p.id, p.video_id, p.start_s, p.end_s, p.text, p.published_at, p.score::double precision
from per_episode p
where p.in_episode <= 2
order by p.score desc, p.id
limit match_count;
$$;

revoke execute on function public.hybrid_search(extensions.vector, text, int) from public, anon, authenticated;
grant execute on function public.hybrid_search(extensions.vector, text, int) to service_role;
