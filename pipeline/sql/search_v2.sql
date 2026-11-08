-- Search v2: the word table behind hybrid_search's keyword side, plus (Ticket 27) the search-box suggestions.
-- NOT RUN YET for the Ticket 27 parts. Run in the Supabase SQL Editor; the whole file is one transaction and is safe to run again.
--
--   Step 1  chunk_terms: how many chunks each word is in (hybrid_search keeps only rare query words).
--   Step 2  fills chunk_terms once. It is NOT refilled on a re-run (that would lock the table while it counts); after
--           chunks are reloaded, empty it first:  truncate public.chunk_terms;  and run this file again.
--   Step 3  hybrid_search lives in search_v3.sql now (this file no longer touches it, so it can never downgrade it).
--   Step 4  pg_trgm and a trigram index on chunk_terms.word, for "did you mean" (near_words, Step 6).
--   Step 5  search_suggestions: what the search box suggests while someone types (guests, topics, episodes, clip titles
--           and a curated vocabulary), filled by pipeline/21_build_search_suggestions.py. The site serves them from an
--           in-memory index; the table is where that index is read from, and the indexes below back any direct lookup.
--   Step 6  near_words(word): the closest words in chunk_terms, for a word typed with a typo.
--   Then one SELECT that checks every object exists.
--
-- Why chunk_terms: v1 ORed every non-filler word of the question, and common words ("first", "round", "india", "start")
-- matched thousands of chunks; ranking them all took past the 8 s statement timeout. v2 keeps only the 3 rarest query
-- words that appear in under 5% of chunks, counted in public.chunk_terms. Names, brands and specific terms stay; meaning
-- is left to the vector side.

begin;
set local statement_timeout = '10min';


-- ---------- Step 1: chunk_terms table ----------

create table if not exists public.chunk_terms (
    word         text primary key,
    chunk_count  integer not null
);
comment on table public.chunk_terms is
    'Number of chunks whose text_search contains each word (ts_stat over chunks). hybrid_search uses it to keep only rare query words, and near_words() to suggest the closest word. Refill after chunks are reloaded.';
alter table public.chunk_terms enable row level security;
revoke all on table public.chunk_terms from anon, authenticated;


-- ---------- Step 2: fill chunk_terms (only when it is empty) ----------

do $$
begin
    if not exists (select 1 from public.chunk_terms limit 1) then
        insert into public.chunk_terms (word, chunk_count)
        select word, ndoc from ts_stat('select text_search from public.chunks');
    end if;
end
$$;
analyze public.chunk_terms;
analyze public.chunks;  -- keeps pg_class.reltuples (the chunk count used for the 5% limit) current


-- ---------- Step 3: hybrid_search ----------
--
-- hybrid_search is defined in pipeline/sql/search_v3.sql (and refined by hybrid_search_scoped.sql), not here: this file
-- used to hold the v2 version, and running it again would have put the old function back over the newer one. Nothing
-- below changes hybrid_search.


-- ---------- Step 4: trigram index on chunk_terms.word ----------

create extension if not exists pg_trgm with schema extensions;

create index if not exists chunk_terms_word_trgm_idx
    on public.chunk_terms using gin (word extensions.gin_trgm_ops);


-- ---------- Step 5: search_suggestions ----------

create table if not exists public.search_suggestions (
    id              bigint generated always as identity primary key,
    kind            text   not null check (kind in ('guest', 'topic', 'episode', 'clip', 'term')),
    -- What the suggestion points at: guest slug, topic (lower-case sector tag), episode video_id, clip id, or the folded
    -- curated term. With kind it is the row's identity, so the builder can run again without making duplicates.
    ref             text   not null,
    text            text   not null,                  -- as shown in the box
    folded          text   not null,                  -- lower case, accents and punctuation out, one space between words
    aliases         text[] not null default '{}',     -- other spellings from the data and the rule-based Devanagari converter
    aliases_ai      text[] not null default '{}',     -- spellings from the one-off Haiku batch (Devanagari, Hinglish, typos)
    aliases_folded  text[] not null default '{}',     -- aliases + aliases_ai, folded the same way as `folded`
    weight          real   not null default 0,        -- ranking inside a kind: guest views, guests per topic, episode views, clip score
    updated_at      timestamptz not null default now(),
    unique (kind, ref)
);
comment on table public.search_suggestions is
    'What the search box suggests while typing. Written only by pipeline/21_build_search_suggestions.py; read by the site server into an in-memory index. folded = lower case, accents and punctuation removed (Devanagari kept).';

create index if not exists search_suggestions_kind_weight_idx on public.search_suggestions (kind, weight desc);
create index if not exists search_suggestions_folded_prefix_idx on public.search_suggestions (folded text_pattern_ops);
create index if not exists search_suggestions_folded_trgm_idx on public.search_suggestions using gin (folded extensions.gin_trgm_ops);
create index if not exists search_suggestions_aliases_idx on public.search_suggestions using gin (aliases_folded);

alter table public.search_suggestions enable row level security;
revoke all on table public.search_suggestions from anon, authenticated;


-- ---------- Step 6: near_words ----------
--
-- The words of chunk_terms closest to a typed word, by trigram similarity, commonest first among equals. For a word that
-- matches nothing ("raisng" -> "raising"). Only words the transcripts really contain come back. The `%` operator uses the
-- default similarity threshold (0.3); p_min_similarity can only make it stricter.

create or replace function public.near_words(p_word text, p_limit integer default 5, p_min_similarity real default 0.4)
returns table (word text, chunk_count integer, similarity real)
language sql
stable
set search_path = public, extensions
as $$
    select t.word, t.chunk_count, extensions.similarity(t.word, lower(btrim(p_word)))::real as similarity
    from public.chunk_terms t
    where t.word operator(extensions.%) lower(btrim(p_word))
      and extensions.similarity(t.word, lower(btrim(p_word))) >= p_min_similarity
      and t.word <> lower(btrim(p_word))
    order by similarity desc, t.chunk_count desc, t.word
    limit greatest(p_limit, 0);
$$;

revoke execute on function public.near_words(text, integer, real) from public, anon, authenticated;
grant execute on function public.near_words(text, integer, real) to service_role;

commit;


-- ---------- Plan checks for hybrid_search (optional, not part of the migration: remove the dashes, one at a time) ----------
--
-- 4a. The semantic part alone: the plan should show "Index Scan using chunks_embedding_idx".
-- explain (analyze, buffers)
-- select c.id, c.embedding <=> (select embedding from public.chunks order by id limit 1) as distance
-- from public.chunks c
-- order by c.embedding <=> (select embedding from public.chunks order by id limit 1)
-- limit 40;
--
-- 4b. Which words the keyword side would keep for a question (the 3 rarest under 5%).
-- select t.word, t.chunk_count,
--        round((100.0 * t.chunk_count
--               / (select reltuples from pg_class where oid = 'public.chunks'::regclass))::numeric, 1) as pct_of_chunks
-- from unnest(to_tsvector('simple', 'What have founders on the show said about raising their first round?')) v
-- join public.chunk_terms t on t.word = v.lexeme
-- order by t.chunk_count;
--
-- 4c. The whole function on a slow question, timed.
-- explain (analyze, buffers)
-- select id, score
-- from public.hybrid_search((select embedding from public.chunks order by id limit 1),
--                           'What have founders on the show said about raising their first round?', 5);


-- ---------- Check: every object exists (one result, ok = true for each) ----------

select 'extension' as kind, 'pg_trgm' as name, exists (select 1 from pg_extension where extname = 'pg_trgm') as ok
union all select 'table', 'chunk_terms', to_regclass('public.chunk_terms') is not null
union all select 'rows', 'chunk_terms is filled', exists (select 1 from public.chunk_terms limit 1)
union all select 'index', 'chunk_terms_word_trgm_idx', to_regclass('public.chunk_terms_word_trgm_idx') is not null
union all select 'table', 'search_suggestions', to_regclass('public.search_suggestions') is not null
union all select 'index', 'search_suggestions_kind_weight_idx', to_regclass('public.search_suggestions_kind_weight_idx') is not null
union all select 'index', 'search_suggestions_folded_prefix_idx', to_regclass('public.search_suggestions_folded_prefix_idx') is not null
union all select 'index', 'search_suggestions_folded_trgm_idx', to_regclass('public.search_suggestions_folded_trgm_idx') is not null
union all select 'index', 'search_suggestions_aliases_idx', to_regclass('public.search_suggestions_aliases_idx') is not null
union all select 'function', 'near_words(text, integer, real)', to_regprocedure('public.near_words(text, integer, real)') is not null
union all select 'function', 'hybrid_search (from search_v3.sql, untouched)', exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'hybrid_search')
order by 1, 2;
