--
-- PostgreSQL database dump
--

\restrict CJl3lBF2aUryui8cgr6GjaRksQMphwb051GCSkIQqq0S4e8QW5CszNdICCcWXJh

-- Dumped from database version 17.11
-- Dumped by pg_dump version 17.11

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: find_line(text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.find_line(query_text text, match_count integer DEFAULT 5) RETURNS TABLE(segment_id bigint, video_id text, seq integer, start_s double precision, end_s double precision, similarity real)
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public', 'extensions'
    AS $$
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


--
-- Name: hybrid_search(extensions.vector, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.hybrid_search(query_embedding extensions.vector, query_text text, match_count integer DEFAULT 20) RETURNS TABLE(id bigint, video_id text, start_s double precision, end_s double precision, text text, published_at timestamp with time zone, score double precision)
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'extensions'
    AS $$
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


--
-- Name: hybrid_search_scoped(extensions.vector, text, integer, text[], integer, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.hybrid_search_scoped(query_embedding extensions.vector, query_text text, match_count integer DEFAULT 20, video_ids text[] DEFAULT NULL::text[], per_episode integer DEFAULT 2, exact_scan boolean DEFAULT true) RETURNS TABLE(id bigint, video_id text, start_s double precision, end_s double precision, text text, published_at timestamp with time zone, score double precision)
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'extensions'
    AS $$
-- The index path asks HNSW for 200 neighbours, and an HNSW scan returns at most hnsw.ef_search rows (40 by default).
-- Set for this transaction only (is_local = true), at run time like find_line.sql does for pg_trgm: a SET clause on the
-- function itself is refused in Supabase ("permission denied to set parameter").
select set_config('hnsw.ef_search', '200', true);

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


--
-- Name: is_test_name(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_test_name(p_key text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$ select p_key in ('arjun', 'test-script', 'tester', 'test-other') $$;


--
-- Name: log_event(text, text, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.log_event(p_name text, p_device_id text, p_type text, p_detail jsonb) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
declare
    vid bigint := public.visitor_for(p_name);
begin
    insert into public.events (visitor_ref, device_id, event_type, detail)
    values (vid, left(p_device_id, 64), p_type, coalesce(p_detail, '{}'::jsonb));
    if vid is not null then
        update public.visitors set last_seen = now() where id = vid and last_seen < now() - interval '1 minute';
    end if;
end;
$$;


--
-- Name: mark_tour_seen(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_tour_seen(p_name text) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
declare
    vid bigint := public.visitor_for(p_name);
begin
    if vid is not null then
        update public.visitors set tour_seen_at = now() where id = vid and tour_seen_at is null;
    end if;
end;
$$;


--
-- Name: near_words(text, integer, real); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.near_words(p_word text, p_limit integer DEFAULT 5, p_min_similarity real DEFAULT 0.4) RETURNS TABLE(word text, chunk_count integer, similarity real)
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'extensions'
    AS $$
    select t.word, t.chunk_count, extensions.similarity(t.word, lower(btrim(p_word)))::real as similarity
    from public.chunk_terms t
    where t.word operator(extensions.%) lower(btrim(p_word))
      and extensions.similarity(t.word, lower(btrim(p_word))) >= p_min_similarity
      and t.word <> lower(btrim(p_word))
    order by similarity desc, t.chunk_count desc, t.word
    limit greatest(p_limit, 0);
$$;


--
-- Name: record_login(text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_login(p_name text, p_device_type text, p_device_id text) RETURNS bigint
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
declare
    k   text := lower(btrim(coalesce(p_name, '')));
    dev text := case when p_device_type in ('phone', 'desktop', 'tablet') then p_device_type else null end;
    vid bigint;
begin
    if k = '' then return null; end if;
    insert into public.visitors as v (name_key, name, login_count, last_device_type, device_types, is_test)
    values (k, btrim(p_name), 1, dev, case when dev is null then '{}' else array[dev] end, public.is_test_name(k))
    on conflict (name_key) do update set
        last_seen        = now(),
        login_count      = v.login_count + 1,
        last_device_type = coalesce(dev, v.last_device_type),
        device_types     = case when dev is null or dev = any (v.device_types) then v.device_types else v.device_types || dev end
    returning v.id into vid;
    insert into public.events (visitor_ref, device_id, event_type, detail)
    values (vid, left(p_device_id, 64), 'login', jsonb_build_object('device', dev));
    return vid;
end;
$$;


--
-- Name: rls_auto_enable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rls_auto_enable() RETURNS event_trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
  tbl name;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        SELECT c.relname INTO tbl FROM pg_catalog.pg_class c WHERE c.oid = cmd.objid;
        EXECUTE format('alter table if exists %I.%I enable row level security', cmd.schema_name, tbl);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;


--
-- Name: set_answer_feedback(bigint, text, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_answer_feedback(p_qa_log_id bigint, p_first_name text, p_visitor_id text, p_rating text, p_note text) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
declare
    n text := nullif(left(btrim(coalesce(p_note, '')), 200), '');
begin
    if p_rating not in ('up', 'down') or btrim(coalesce(p_first_name, '')) = '' then
        raise exception 'bad feedback';
    end if;
    if not exists (select 1 from public.qa_log where id = p_qa_log_id) then
        return false;
    end if;
    insert into public.answer_feedback as f (qa_log_id, rating, note, first_name, visitor_id)
    values (p_qa_log_id, p_rating, case when p_rating = 'down' then n end, btrim(p_first_name), left(p_visitor_id, 64))
    on conflict (qa_log_id, name_key) do update set
        rating     = excluded.rating,
        note       = case when excluded.rating = 'down' then coalesce(excluded.note, case when f.rating = 'down' then f.note end) end,
        visitor_id = coalesce(excluded.visitor_id, f.visitor_id),
        updated_at = now();
    return true;
end;
$$;


--
-- Name: set_clip_guest_share(bigint[], double precision[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_clip_guest_share(ids bigint[], shares double precision[]) RETURNS integer
    LANGUAGE sql
    SET search_path TO 'public'
    AS $$
    with input as (
        select u.id, u.share
        from unnest(ids, shares) as u(id, share)
    ),
    changed as (
        update public.clips c
        set guest_share = i.share
        from input i
        where c.id = i.id
        returning c.id
    )
    select count(*)::integer from changed;
$$;


--
-- Name: set_visitor_ref(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_visitor_ref() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
begin
    if new.visitor_ref is null then
        begin
            new.visitor_ref := public.visitor_for(new.first_name);
        exception when others then
            new.visitor_ref := null;
        end;
    end if;
    return new;
end;
$$;


--
-- Name: take_rate_limit(text, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.take_rate_limit(p_key text, p_max integer, p_window_s integer) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
declare
    ws timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_s) * p_window_s);
    c  integer;
begin
    insert into public.rate_limits as r (key, window_start, count)
    values (p_key, ws, 1)
    on conflict (key, window_start) do update set count = r.count + 1
    returning r.count into c;

    -- Housekeeping: about one call in fifty removes windows older than two days.
    if random() < 0.02 then
        delete from public.rate_limits where window_start < now() - interval '2 days';
    end if;

    return c <= p_max;
end;
$$;


--
-- Name: visitor_for(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.visitor_for(p_name text) RETURNS bigint
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
declare
    k text := lower(btrim(coalesce(p_name, '')));
    v bigint;
begin
    if k = '' then return null; end if;
    select id into v from public.visitors where name_key = k;
    if v is null then
        insert into public.visitors (name_key, name, is_test)
        values (k, btrim(p_name), public.is_test_name(k))
        on conflict (name_key) do nothing;
        select id into v from public.visitors where name_key = k;
    end if;
    return v;
end;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: answer_feedback; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.answer_feedback (
    id bigint NOT NULL,
    qa_log_id bigint NOT NULL,
    rating text NOT NULL,
    note text,
    first_name text NOT NULL,
    name_key text GENERATED ALWAYS AS (lower(btrim(first_name))) STORED,
    visitor_id text,
    visitor_ref bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT answer_feedback_check CHECK (((note IS NULL) OR ((char_length(note) <= 200) AND (rating = 'down'::text)))),
    CONSTRAINT answer_feedback_first_name_check CHECK ((btrim(first_name) <> ''::text)),
    CONSTRAINT answer_feedback_rating_check CHECK ((rating = ANY (ARRAY['up'::text, 'down'::text])))
);


--
-- Name: TABLE answer_feedback; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.answer_feedback IS 'Thumbs up/down on an Ask answer or Prep brief (qa_log row). One vote per person per answer; changing a vote updates the row. note = the one-line "what was wrong" after a thumbs-down.';


--
-- Name: answer_feedback_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.answer_feedback ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.answer_feedback_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: qa_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qa_log (
    id bigint NOT NULL,
    question text NOT NULL,
    answer text,
    cited_chunk_ids integer[],
    visitor_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    language text,
    found boolean,
    first_name text,
    latency_ms integer,
    timings jsonb,
    kind text DEFAULT 'ask'::text NOT NULL,
    visitor_ref bigint,
    scope jsonb,
    CONSTRAINT qa_log_kind_check CHECK ((kind = ANY (ARRAY['ask'::text, 'brief'::text]))),
    CONSTRAINT qa_log_language_check CHECK ((language = ANY (ARRAY['en'::text, 'hi'::text, 'hinglish'::text])))
);


--
-- Name: TABLE qa_log; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.qa_log IS 'Log of questions asked on the website, the answers given and the chunk IDs they cited.';


--
-- Name: COLUMN qa_log.scope; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.qa_log.scope IS 'Ask within a scope (Ticket 28d): null = the whole archive; else {guest?, topic?, year?, lang?, label, episodes}.';


--
-- Name: visitors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.visitors (
    id bigint NOT NULL,
    name_key text NOT NULL,
    name text NOT NULL,
    first_seen timestamp with time zone DEFAULT now() NOT NULL,
    last_seen timestamp with time zone DEFAULT now() NOT NULL,
    login_count integer DEFAULT 0 NOT NULL,
    last_device_type text,
    device_types text[] DEFAULT '{}'::text[] NOT NULL,
    is_test boolean DEFAULT false NOT NULL,
    note text,
    tour_seen_at timestamp with time zone,
    CONSTRAINT visitors_device_types_check CHECK ((device_types <@ ARRAY['phone'::text, 'desktop'::text, 'tablet'::text])),
    CONSTRAINT visitors_last_device_type_check CHECK ((last_device_type = ANY (ARRAY['phone'::text, 'desktop'::text, 'tablet'::text]))),
    CONSTRAINT visitors_name_key_check CHECK (((name_key = lower(btrim(name_key))) AND (name_key <> ''::text)))
);


--
-- Name: TABLE visitors; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.visitors IS 'One row per person, keyed by lower-cased first name. login_count and device_types count from the day this ran; first_seen/last_seen are backfilled from the old logs. is_test marks the owner''s and test names (see is_test_name()).';


--
-- Name: COLUMN visitors.tour_seen_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.visitors.tour_seen_at IS 'When this person first closed the welcome tour (null: not yet, so the tour opens on their next page load).';


--
-- Name: answer_feedback_view; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.answer_feedback_view WITH (security_invoker='true') AS
 SELECT f.id,
    f.created_at,
    f.updated_at,
    f.rating,
    f.note,
    f.first_name,
    v.is_test,
    q.kind,
    q.found,
    q.language,
    q.question,
    "left"(q.answer, 300) AS answer_excerpt,
    q.latency_ms,
    f.qa_log_id
   FROM ((public.answer_feedback f
     JOIN public.qa_log q ON ((q.id = f.qa_log_id)))
     LEFT JOIN public.visitors v ON ((v.id = f.visitor_ref)))
  ORDER BY f.created_at DESC;


--
-- Name: chunk_terms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chunk_terms (
    word text NOT NULL,
    chunk_count integer NOT NULL
);


--
-- Name: TABLE chunk_terms; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.chunk_terms IS 'Number of chunks whose text_search contains each word (ts_stat over chunks). hybrid_search uses it to keep only rare query words, and near_words() to suggest the closest word. Refill after chunks are reloaded.';


--
-- Name: chunks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chunks (
    id bigint NOT NULL,
    video_id text NOT NULL,
    start_s double precision NOT NULL,
    end_s double precision NOT NULL,
    text text NOT NULL,
    published_at timestamp with time zone,
    embedding extensions.vector(512),
    text_search tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, COALESCE(text, ''::text))) STORED
);


--
-- Name: TABLE chunks; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.chunks IS 'Retrieval chunks of transcript text with a 512-dimension embedding (vector search) and a simple-config tsvector (keyword search) for question answering.';


--
-- Name: chunks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.chunks ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.chunks_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: clips; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.clips (
    id bigint NOT NULL,
    video_id text NOT NULL,
    start_s double precision NOT NULL,
    end_s double precision NOT NULL,
    opening_line text,
    topic text,
    score double precision,
    verified boolean DEFAULT false NOT NULL,
    model text,
    run_id text,
    check_notes text,
    guest_share double precision
);


--
-- Name: TABLE clips; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.clips IS 'Candidate short clips (time ranges) picked by the model, with a score; only verified clips are shown.';


--
-- Name: COLUMN clips.guest_share; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.clips.guest_share IS 'Share (0 to 1) of the clip''s spoken time labelled guest in segments.speaker; set by pipeline/15_clip_speakers.py.';


--
-- Name: clips_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.clips ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.clips_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: episodes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.episodes (
    video_id text NOT NULL,
    title text NOT NULL,
    published_at timestamp with time zone,
    duration_seconds integer,
    view_count bigint,
    like_count bigint,
    comment_count bigint,
    url text,
    caption_language text,
    in_test_set boolean DEFAULT false NOT NULL,
    status text
);


--
-- Name: TABLE episodes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.episodes IS 'One row per Figuring Out YouTube episode: metadata, caption language, test-set flag and pipeline status.';


--
-- Name: events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.events (
    id bigint NOT NULL,
    visitor_ref bigint,
    device_id text,
    event_type text NOT NULL,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT events_detail_check CHECK ((octet_length((detail)::text) <= 1000)),
    CONSTRAINT events_event_type_check CHECK ((event_type = ANY (ARRAY['login'::text, 'page_view'::text, 'find_line'::text, 'play_all'::text, 'search'::text])))
);


--
-- Name: TABLE events; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.events IS 'Actions not already in qa_log / saved_items / reports. detail by type: login {device}; page_view {path, q?, topic?, guest?, ...} (no raw URLs); find_line {q}; play_all {answer?, clips}; search {q, pick?, n?}. device_id is the visitor_id browser cookie.';


--
-- Name: events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: feedback; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feedback (
    id bigint NOT NULL,
    page text NOT NULL,
    item_id bigint,
    note text,
    visitor_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE feedback; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.feedback IS 'Notes left by website visitors about a page or an item on it.';


--
-- Name: feedback_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.feedback ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.feedback_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: guests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.guests (
    id bigint NOT NULL,
    name text NOT NULL,
    organisation text,
    role_at_episode text,
    sector_tags text[],
    bio text,
    linkedin_url text,
    linkedin_verified boolean DEFAULT false NOT NULL,
    youtube_channel_url text,
    video_id text,
    model text,
    run_id text,
    verified boolean DEFAULT false NOT NULL,
    check_notes text,
    guest_key text,
    youtube_verified boolean DEFAULT false,
    wikipedia_url text,
    wikipedia_description text,
    wikipedia_verified boolean DEFAULT false NOT NULL,
    link_source text,
    linkedin_search_url text,
    photo_url text,
    photo_credit text,
    photo_license text,
    photo_source text
);


--
-- Name: TABLE guests; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.guests IS 'Guests per episode as extracted by the model. Contact data is limited to verified LinkedIn and YouTube channel links; never phone numbers or emails.';


--
-- Name: COLUMN guests.photo_url; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.guests.photo_url IS 'Only set for a freely licensed Wikimedia Commons image (CC0, public domain, CC BY, CC BY-SA); never a YouTube thumbnail.';


--
-- Name: guests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.guests ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.guests_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: insights; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.insights (
    id bigint NOT NULL,
    video_id text NOT NULL,
    guest_id bigint,
    type text NOT NULL,
    category text,
    text text NOT NULL,
    start_s double precision,
    end_s double precision,
    source_segment_ids integer[],
    translated boolean DEFAULT false NOT NULL,
    verified boolean DEFAULT false NOT NULL,
    check_notes text,
    model text,
    run_id text,
    CONSTRAINT insights_category_check CHECK ((category = ANY (ARRAY['growing_sectors'::text, 'business_ideas'::text, 'market_gaps'::text, 'underrated_skills'::text, 'career_paths'::text, 'investment_themes'::text, 'hiring_signals'::text, 'policy_shifts'::text, 'geographic_opportunities'::text, 'tools_and_tech'::text, 'contrarian_takes'::text, 'resources'::text, 'warnings'::text]))),
    CONSTRAINT insights_type_check CHECK ((type = ANY (ARRAY['takeaway'::text, 'opportunity'::text, 'quote'::text, 'disagreement'::text, 'raj_opinion'::text, 'raj_question'::text])))
);


--
-- Name: TABLE insights; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.insights IS 'Model-extracted takeaways, opportunities, quotes, disagreements and Raj''s opinions/questions, each traced to transcript segment IDs and timestamps. Only verified rows are shown on the site.';


--
-- Name: insights_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.insights ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.insights_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: qa_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.qa_log ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.qa_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: rate_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rate_limits (
    key text NOT NULL,
    window_start timestamp with time zone NOT NULL,
    count integer DEFAULT 0 NOT NULL
);


--
-- Name: TABLE rate_limits; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.rate_limits IS 'Fixed-window counters for the site''s rate limits: one row per key and window. Old windows are deleted now and then.';


--
-- Name: reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reports (
    id bigint NOT NULL,
    item_type text NOT NULL,
    item_id text NOT NULL,
    video_id text,
    start_s double precision,
    reason text NOT NULL,
    note text,
    first_name text NOT NULL,
    visitor_id text,
    page text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'new'::text NOT NULL,
    visitor_ref bigint,
    CONSTRAINT reports_item_type_check CHECK ((item_type = ANY (ARRAY['clip'::text, 'episode'::text, 'answer'::text, 'insight'::text, 'brief'::text, 'guest'::text]))),
    CONSTRAINT reports_note_check CHECK (((note IS NULL) OR (char_length(note) <= 280))),
    CONSTRAINT reports_reason_check CHECK ((reason = ANY (ARRAY['Wrong timestamp'::text, 'Wrong speaker'::text, 'Wrong fact or quote'::text, 'Transcript error'::text, 'Something else'::text])))
);


--
-- Name: TABLE reports; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.reports IS 'Error reports sent from the site: item, moment, reason, optional note, first name and visitor id. Review queue.';


--
-- Name: reports_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.reports ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.reports_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reviews (
    id bigint NOT NULL,
    item_table text NOT NULL,
    item_id bigint NOT NULL,
    verdict text NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reviews_verdict_check CHECK ((verdict = ANY (ARRAY['correct'::text, 'wrong'::text, 'unsure'::text])))
);


--
-- Name: TABLE reviews; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.reviews IS 'Manual review verdicts on rows in other tables (for example insights or clips), used to decide what is verified.';


--
-- Name: reviews_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.reviews ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.reviews_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: saved_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.saved_items (
    id bigint NOT NULL,
    visitor_id text,
    first_name text NOT NULL,
    kind text NOT NULL,
    item_ref jsonb NOT NULL,
    folder text,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    visitor_ref bigint,
    CONSTRAINT saved_items_kind_check CHECK ((kind = ANY (ARRAY['clip'::text, 'answer'::text, 'brief'::text]))),
    CONSTRAINT saved_items_note_check CHECK (((note IS NULL) OR (char_length(note) <= 500)))
);


--
-- Name: TABLE saved_items; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.saved_items IS 'Clips, answers and briefs saved from the site: who (visitor id and first name), what (kind + item_ref), optional folder and note.';


--
-- Name: saved_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.saved_items ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.saved_items_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: search_suggestions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.search_suggestions (
    id bigint NOT NULL,
    kind text NOT NULL,
    ref text NOT NULL,
    text text NOT NULL,
    folded text NOT NULL,
    aliases text[] DEFAULT '{}'::text[] NOT NULL,
    aliases_ai text[] DEFAULT '{}'::text[] NOT NULL,
    aliases_folded text[] DEFAULT '{}'::text[] NOT NULL,
    weight real DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT search_suggestions_kind_check CHECK ((kind = ANY (ARRAY['guest'::text, 'topic'::text, 'episode'::text, 'clip'::text, 'term'::text])))
);


--
-- Name: TABLE search_suggestions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.search_suggestions IS 'What the search box suggests while typing. Written only by pipeline/21_build_search_suggestions.py; read by the site server into an in-memory index. folded = lower case, accents and punctuation removed (Devanagari kept).';


--
-- Name: search_suggestions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.search_suggestions ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.search_suggestions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: segments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.segments (
    id bigint NOT NULL,
    video_id text NOT NULL,
    seq integer NOT NULL,
    start_s double precision NOT NULL,
    end_s double precision NOT NULL,
    speaker text DEFAULT 'unknown'::text NOT NULL,
    text_original text NOT NULL,
    text_roman text NOT NULL,
    source text NOT NULL,
    CONSTRAINT segments_source_check CHECK ((source = ANY (ARRAY['youtube_auto'::text, 'groq'::text, 'sarvam'::text]))),
    CONSTRAINT segments_speaker_check CHECK ((speaker = ANY (ARRAY['raj'::text, 'guest'::text, 'unknown'::text])))
);


--
-- Name: TABLE segments; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.segments IS 'Timed transcript lines per episode, in original script and Roman script (identical for English episodes). Segment IDs are what every claim on the site points back to.';


--
-- Name: segments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.segments ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.segments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: site_stats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.site_stats (
    id smallint DEFAULT 1 NOT NULL,
    stats jsonb NOT NULL,
    counted_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT site_stats_id_check CHECK ((id = 1))
);


--
-- Name: TABLE site_stats; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.site_stats IS 'Home page counts (verified rows, final run), written by pipeline/site_stats.py; one row, id = 1.';


--
-- Name: thumbnail_features; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.thumbnail_features (
    episode_id text NOT NULL,
    features jsonb NOT NULL,
    model_version text NOT NULL,
    analysed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE thumbnail_features; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.thumbnail_features IS 'Features of each episode''s YouTube thumbnail (faces, text, colours, brightness), from pipeline/17_thumbnail_features.py. No images are stored.';


--
-- Name: translation_segments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.translation_segments (
    id bigint NOT NULL,
    video_id text NOT NULL,
    start_s double precision NOT NULL,
    end_s double precision NOT NULL,
    text text NOT NULL
);


--
-- Name: TABLE translation_segments; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.translation_segments IS 'YouTube''s automatic English translation of Hindi episodes, timed lines; Hindi episodes only.';


--
-- Name: translation_segments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.translation_segments ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.translation_segments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: visitor_activity; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.visitor_activity WITH (security_invoker='true') AS
 SELECT id,
    name,
    first_seen,
    last_seen,
    login_count,
    last_device_type,
    device_types,
    is_test,
    note,
    ( SELECT count(*) AS count
           FROM public.qa_log q
          WHERE ((q.visitor_ref = v.id) AND (q.kind = 'ask'::text))) AS asks,
    ( SELECT count(*) AS count
           FROM public.qa_log q
          WHERE ((q.visitor_ref = v.id) AND (q.kind = 'brief'::text) AND (q.question !~~ '[web] %'::text))) AS briefs,
    ( SELECT count(*) AS count
           FROM public.qa_log q
          WHERE ((q.visitor_ref = v.id) AND (q.question ~~ '[web] %'::text))) AS web_research,
    ( SELECT count(*) AS count
           FROM public.saved_items s
          WHERE (s.visitor_ref = v.id)) AS saved,
    ( SELECT count(*) AS count
           FROM public.reports r
          WHERE (r.visitor_ref = v.id)) AS reports,
    ( SELECT count(*) AS count
           FROM public.events e
          WHERE ((e.visitor_ref = v.id) AND (e.event_type = 'page_view'::text))) AS page_views,
    ( SELECT count(DISTINCT e.device_id) AS count
           FROM public.events e
          WHERE (e.visitor_ref = v.id)) AS devices,
    tour_seen_at
   FROM public.visitors v;


--
-- Name: visitors_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.visitors ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.visitors_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: answer_feedback answer_feedback_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.answer_feedback
    ADD CONSTRAINT answer_feedback_pkey PRIMARY KEY (id);


--
-- Name: answer_feedback answer_feedback_qa_log_id_name_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.answer_feedback
    ADD CONSTRAINT answer_feedback_qa_log_id_name_key_key UNIQUE (qa_log_id, name_key);


--
-- Name: chunk_terms chunk_terms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chunk_terms
    ADD CONSTRAINT chunk_terms_pkey PRIMARY KEY (word);


--
-- Name: chunks chunks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chunks
    ADD CONSTRAINT chunks_pkey PRIMARY KEY (id);


--
-- Name: clips clips_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clips
    ADD CONSTRAINT clips_pkey PRIMARY KEY (id);


--
-- Name: episodes episodes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.episodes
    ADD CONSTRAINT episodes_pkey PRIMARY KEY (video_id);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);


--
-- Name: feedback feedback_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feedback
    ADD CONSTRAINT feedback_pkey PRIMARY KEY (id);


--
-- Name: guests guests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guests
    ADD CONSTRAINT guests_pkey PRIMARY KEY (id);


--
-- Name: insights insights_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insights
    ADD CONSTRAINT insights_pkey PRIMARY KEY (id);


--
-- Name: qa_log qa_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_log
    ADD CONSTRAINT qa_log_pkey PRIMARY KEY (id);


--
-- Name: rate_limits rate_limits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_limits
    ADD CONSTRAINT rate_limits_pkey PRIMARY KEY (key, window_start);


--
-- Name: reports reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_pkey PRIMARY KEY (id);


--
-- Name: reviews reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_pkey PRIMARY KEY (id);


--
-- Name: saved_items saved_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_items
    ADD CONSTRAINT saved_items_pkey PRIMARY KEY (id);


--
-- Name: search_suggestions search_suggestions_kind_ref_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_suggestions
    ADD CONSTRAINT search_suggestions_kind_ref_key UNIQUE (kind, ref);


--
-- Name: search_suggestions search_suggestions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_suggestions
    ADD CONSTRAINT search_suggestions_pkey PRIMARY KEY (id);


--
-- Name: segments segments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.segments
    ADD CONSTRAINT segments_pkey PRIMARY KEY (id);


--
-- Name: segments segments_video_id_seq_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.segments
    ADD CONSTRAINT segments_video_id_seq_key UNIQUE (video_id, seq);


--
-- Name: site_stats site_stats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.site_stats
    ADD CONSTRAINT site_stats_pkey PRIMARY KEY (id);


--
-- Name: thumbnail_features thumbnail_features_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.thumbnail_features
    ADD CONSTRAINT thumbnail_features_pkey PRIMARY KEY (episode_id);


--
-- Name: translation_segments translation_segments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.translation_segments
    ADD CONSTRAINT translation_segments_pkey PRIMARY KEY (id);


--
-- Name: visitors visitors_name_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.visitors
    ADD CONSTRAINT visitors_name_key_key UNIQUE (name_key);


--
-- Name: visitors visitors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.visitors
    ADD CONSTRAINT visitors_pkey PRIMARY KEY (id);


--
-- Name: answer_feedback_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX answer_feedback_created_idx ON public.answer_feedback USING btree (created_at DESC);


--
-- Name: answer_feedback_rating_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX answer_feedback_rating_idx ON public.answer_feedback USING btree (rating, created_at DESC);


--
-- Name: answer_feedback_visitor_ref_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX answer_feedback_visitor_ref_idx ON public.answer_feedback USING btree (visitor_ref);


--
-- Name: chunk_terms_word_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chunk_terms_word_trgm_idx ON public.chunk_terms USING gin (word extensions.gin_trgm_ops);


--
-- Name: chunks_embedding_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chunks_embedding_idx ON public.chunks USING hnsw (embedding extensions.vector_cosine_ops);


--
-- Name: chunks_text_search_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chunks_text_search_idx ON public.chunks USING gin (text_search);


--
-- Name: chunks_video_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chunks_video_idx ON public.chunks USING btree (video_id, start_s);


--
-- Name: clips_video_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX clips_video_idx ON public.clips USING btree (video_id);


--
-- Name: events_type_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_type_created_idx ON public.events USING btree (event_type, created_at DESC);


--
-- Name: events_visitor_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_visitor_created_idx ON public.events USING btree (visitor_ref, created_at DESC);


--
-- Name: guests_guest_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX guests_guest_key_idx ON public.guests USING btree (guest_key);


--
-- Name: guests_video_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX guests_video_idx ON public.guests USING btree (video_id);


--
-- Name: insights_type_category_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX insights_type_category_idx ON public.insights USING btree (type, category);


--
-- Name: insights_video_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX insights_video_idx ON public.insights USING btree (video_id);


--
-- Name: qa_log_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX qa_log_created_idx ON public.qa_log USING btree (created_at DESC);


--
-- Name: qa_log_kind_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX qa_log_kind_created_idx ON public.qa_log USING btree (kind, created_at DESC);


--
-- Name: qa_log_scoped_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX qa_log_scoped_idx ON public.qa_log USING btree (created_at DESC) WHERE (scope IS NOT NULL);


--
-- Name: qa_log_visitor_ref_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX qa_log_visitor_ref_idx ON public.qa_log USING btree (visitor_ref, created_at DESC);


--
-- Name: reports_status_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reports_status_created_idx ON public.reports USING btree (status, created_at DESC);


--
-- Name: reports_visitor_ref_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reports_visitor_ref_idx ON public.reports USING btree (visitor_ref);


--
-- Name: reviews_item_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reviews_item_idx ON public.reviews USING btree (item_table, item_id);


--
-- Name: saved_items_visitor_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX saved_items_visitor_created_idx ON public.saved_items USING btree (visitor_id, created_at DESC);


--
-- Name: saved_items_visitor_ref_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX saved_items_visitor_ref_idx ON public.saved_items USING btree (visitor_ref);


--
-- Name: search_suggestions_aliases_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX search_suggestions_aliases_idx ON public.search_suggestions USING gin (aliases_folded);


--
-- Name: search_suggestions_folded_prefix_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX search_suggestions_folded_prefix_idx ON public.search_suggestions USING btree (folded text_pattern_ops);


--
-- Name: search_suggestions_folded_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX search_suggestions_folded_trgm_idx ON public.search_suggestions USING gin (folded extensions.gin_trgm_ops);


--
-- Name: search_suggestions_kind_weight_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX search_suggestions_kind_weight_idx ON public.search_suggestions USING btree (kind, weight DESC);


--
-- Name: segments_text_original_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX segments_text_original_trgm_idx ON public.segments USING gin (text_original extensions.gin_trgm_ops);


--
-- Name: segments_text_roman_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX segments_text_roman_trgm_idx ON public.segments USING gin (text_roman extensions.gin_trgm_ops);


--
-- Name: translation_segments_video_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX translation_segments_video_idx ON public.translation_segments USING btree (video_id, start_s);


--
-- Name: answer_feedback answer_feedback_visitor_ref; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER answer_feedback_visitor_ref BEFORE INSERT ON public.answer_feedback FOR EACH ROW EXECUTE FUNCTION public.set_visitor_ref();


--
-- Name: qa_log qa_log_visitor_ref; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER qa_log_visitor_ref BEFORE INSERT ON public.qa_log FOR EACH ROW EXECUTE FUNCTION public.set_visitor_ref();


--
-- Name: reports reports_visitor_ref; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER reports_visitor_ref BEFORE INSERT ON public.reports FOR EACH ROW EXECUTE FUNCTION public.set_visitor_ref();


--
-- Name: saved_items saved_items_visitor_ref; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER saved_items_visitor_ref BEFORE INSERT ON public.saved_items FOR EACH ROW EXECUTE FUNCTION public.set_visitor_ref();


--
-- Name: answer_feedback answer_feedback_qa_log_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.answer_feedback
    ADD CONSTRAINT answer_feedback_qa_log_id_fkey FOREIGN KEY (qa_log_id) REFERENCES public.qa_log(id) ON DELETE CASCADE;


--
-- Name: answer_feedback answer_feedback_visitor_ref_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.answer_feedback
    ADD CONSTRAINT answer_feedback_visitor_ref_fkey FOREIGN KEY (visitor_ref) REFERENCES public.visitors(id) ON DELETE SET NULL;


--
-- Name: chunks chunks_video_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chunks
    ADD CONSTRAINT chunks_video_id_fkey FOREIGN KEY (video_id) REFERENCES public.episodes(video_id) ON DELETE CASCADE;


--
-- Name: clips clips_video_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clips
    ADD CONSTRAINT clips_video_id_fkey FOREIGN KEY (video_id) REFERENCES public.episodes(video_id) ON DELETE CASCADE;


--
-- Name: events events_visitor_ref_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_visitor_ref_fkey FOREIGN KEY (visitor_ref) REFERENCES public.visitors(id) ON DELETE SET NULL;


--
-- Name: guests guests_video_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guests
    ADD CONSTRAINT guests_video_id_fkey FOREIGN KEY (video_id) REFERENCES public.episodes(video_id) ON DELETE CASCADE;


--
-- Name: insights insights_guest_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insights
    ADD CONSTRAINT insights_guest_id_fkey FOREIGN KEY (guest_id) REFERENCES public.guests(id) ON DELETE SET NULL;


--
-- Name: insights insights_video_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insights
    ADD CONSTRAINT insights_video_id_fkey FOREIGN KEY (video_id) REFERENCES public.episodes(video_id) ON DELETE CASCADE;


--
-- Name: qa_log qa_log_visitor_ref_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_log
    ADD CONSTRAINT qa_log_visitor_ref_fkey FOREIGN KEY (visitor_ref) REFERENCES public.visitors(id) ON DELETE SET NULL;


--
-- Name: reports reports_video_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_video_id_fkey FOREIGN KEY (video_id) REFERENCES public.episodes(video_id) ON DELETE SET NULL;


--
-- Name: reports reports_visitor_ref_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_visitor_ref_fkey FOREIGN KEY (visitor_ref) REFERENCES public.visitors(id) ON DELETE SET NULL;


--
-- Name: saved_items saved_items_visitor_ref_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_items
    ADD CONSTRAINT saved_items_visitor_ref_fkey FOREIGN KEY (visitor_ref) REFERENCES public.visitors(id) ON DELETE SET NULL;


--
-- Name: segments segments_video_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.segments
    ADD CONSTRAINT segments_video_id_fkey FOREIGN KEY (video_id) REFERENCES public.episodes(video_id) ON DELETE CASCADE;


--
-- Name: thumbnail_features thumbnail_features_episode_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.thumbnail_features
    ADD CONSTRAINT thumbnail_features_episode_id_fkey FOREIGN KEY (episode_id) REFERENCES public.episodes(video_id) ON DELETE CASCADE;


--
-- Name: translation_segments translation_segments_video_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.translation_segments
    ADD CONSTRAINT translation_segments_video_id_fkey FOREIGN KEY (video_id) REFERENCES public.episodes(video_id) ON DELETE CASCADE;


--
-- Name: answer_feedback; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.answer_feedback ENABLE ROW LEVEL SECURITY;

--
-- Name: chunk_terms; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.chunk_terms ENABLE ROW LEVEL SECURITY;

--
-- Name: chunks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.chunks ENABLE ROW LEVEL SECURITY;

--
-- Name: clips; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.clips ENABLE ROW LEVEL SECURITY;

--
-- Name: episodes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.episodes ENABLE ROW LEVEL SECURITY;

--
-- Name: events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;

--
-- Name: feedback; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.feedback ENABLE ROW LEVEL SECURITY;

--
-- Name: guests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.guests ENABLE ROW LEVEL SECURITY;

--
-- Name: insights; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.insights ENABLE ROW LEVEL SECURITY;

--
-- Name: qa_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.qa_log ENABLE ROW LEVEL SECURITY;

--
-- Name: rate_limits; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;

--
-- Name: reports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;

--
-- Name: reviews; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;

--
-- Name: saved_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.saved_items ENABLE ROW LEVEL SECURITY;

--
-- Name: search_suggestions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.search_suggestions ENABLE ROW LEVEL SECURITY;

--
-- Name: segments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.segments ENABLE ROW LEVEL SECURITY;

--
-- Name: site_stats; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.site_stats ENABLE ROW LEVEL SECURITY;

--
-- Name: thumbnail_features; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.thumbnail_features ENABLE ROW LEVEL SECURITY;

--
-- Name: translation_segments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.translation_segments ENABLE ROW LEVEL SECURITY;

--
-- Name: visitors; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.visitors ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;


--
-- Name: FUNCTION find_line(query_text text, match_count integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.find_line(query_text text, match_count integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.find_line(query_text text, match_count integer) TO service_role;


--
-- Name: FUNCTION hybrid_search(query_embedding extensions.vector, query_text text, match_count integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.hybrid_search(query_embedding extensions.vector, query_text text, match_count integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.hybrid_search(query_embedding extensions.vector, query_text text, match_count integer) TO service_role;


--
-- Name: FUNCTION hybrid_search_scoped(query_embedding extensions.vector, query_text text, match_count integer, video_ids text[], per_episode integer, exact_scan boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.hybrid_search_scoped(query_embedding extensions.vector, query_text text, match_count integer, video_ids text[], per_episode integer, exact_scan boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.hybrid_search_scoped(query_embedding extensions.vector, query_text text, match_count integer, video_ids text[], per_episode integer, exact_scan boolean) TO service_role;


--
-- Name: FUNCTION is_test_name(p_key text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.is_test_name(p_key text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_test_name(p_key text) TO service_role;


--
-- Name: FUNCTION log_event(p_name text, p_device_id text, p_type text, p_detail jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.log_event(p_name text, p_device_id text, p_type text, p_detail jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.log_event(p_name text, p_device_id text, p_type text, p_detail jsonb) TO service_role;


--
-- Name: FUNCTION mark_tour_seen(p_name text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.mark_tour_seen(p_name text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.mark_tour_seen(p_name text) TO service_role;


--
-- Name: FUNCTION near_words(p_word text, p_limit integer, p_min_similarity real); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.near_words(p_word text, p_limit integer, p_min_similarity real) FROM PUBLIC;
GRANT ALL ON FUNCTION public.near_words(p_word text, p_limit integer, p_min_similarity real) TO service_role;


--
-- Name: FUNCTION record_login(p_name text, p_device_type text, p_device_id text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.record_login(p_name text, p_device_type text, p_device_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_login(p_name text, p_device_type text, p_device_id text) TO service_role;


--
-- Name: FUNCTION rls_auto_enable(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.rls_auto_enable() TO anon;
GRANT ALL ON FUNCTION public.rls_auto_enable() TO authenticated;
GRANT ALL ON FUNCTION public.rls_auto_enable() TO service_role;


--
-- Name: FUNCTION set_answer_feedback(p_qa_log_id bigint, p_first_name text, p_visitor_id text, p_rating text, p_note text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.set_answer_feedback(p_qa_log_id bigint, p_first_name text, p_visitor_id text, p_rating text, p_note text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.set_answer_feedback(p_qa_log_id bigint, p_first_name text, p_visitor_id text, p_rating text, p_note text) TO service_role;


--
-- Name: FUNCTION set_clip_guest_share(ids bigint[], shares double precision[]); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.set_clip_guest_share(ids bigint[], shares double precision[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.set_clip_guest_share(ids bigint[], shares double precision[]) TO service_role;


--
-- Name: FUNCTION set_visitor_ref(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.set_visitor_ref() FROM PUBLIC;
GRANT ALL ON FUNCTION public.set_visitor_ref() TO service_role;


--
-- Name: FUNCTION take_rate_limit(p_key text, p_max integer, p_window_s integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.take_rate_limit(p_key text, p_max integer, p_window_s integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.take_rate_limit(p_key text, p_max integer, p_window_s integer) TO service_role;


--
-- Name: FUNCTION visitor_for(p_name text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.visitor_for(p_name text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.visitor_for(p_name text) TO service_role;


--
-- Name: TABLE answer_feedback; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.answer_feedback TO service_role;


--
-- Name: SEQUENCE answer_feedback_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.answer_feedback_id_seq TO anon;
GRANT ALL ON SEQUENCE public.answer_feedback_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.answer_feedback_id_seq TO service_role;


--
-- Name: TABLE qa_log; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.qa_log TO service_role;


--
-- Name: TABLE visitors; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.visitors TO service_role;


--
-- Name: TABLE answer_feedback_view; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.answer_feedback_view TO service_role;


--
-- Name: TABLE chunk_terms; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.chunk_terms TO service_role;


--
-- Name: TABLE chunks; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.chunks TO anon;
GRANT ALL ON TABLE public.chunks TO authenticated;
GRANT ALL ON TABLE public.chunks TO service_role;


--
-- Name: SEQUENCE chunks_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.chunks_id_seq TO anon;
GRANT ALL ON SEQUENCE public.chunks_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.chunks_id_seq TO service_role;


--
-- Name: TABLE clips; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.clips TO anon;
GRANT ALL ON TABLE public.clips TO authenticated;
GRANT ALL ON TABLE public.clips TO service_role;


--
-- Name: SEQUENCE clips_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.clips_id_seq TO anon;
GRANT ALL ON SEQUENCE public.clips_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.clips_id_seq TO service_role;


--
-- Name: TABLE episodes; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.episodes TO anon;
GRANT ALL ON TABLE public.episodes TO authenticated;
GRANT ALL ON TABLE public.episodes TO service_role;


--
-- Name: TABLE events; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.events TO service_role;


--
-- Name: SEQUENCE events_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.events_id_seq TO anon;
GRANT ALL ON SEQUENCE public.events_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.events_id_seq TO service_role;


--
-- Name: TABLE feedback; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.feedback TO anon;
GRANT ALL ON TABLE public.feedback TO authenticated;
GRANT ALL ON TABLE public.feedback TO service_role;


--
-- Name: SEQUENCE feedback_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.feedback_id_seq TO anon;
GRANT ALL ON SEQUENCE public.feedback_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.feedback_id_seq TO service_role;


--
-- Name: TABLE guests; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.guests TO anon;
GRANT ALL ON TABLE public.guests TO authenticated;
GRANT ALL ON TABLE public.guests TO service_role;


--
-- Name: SEQUENCE guests_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.guests_id_seq TO anon;
GRANT ALL ON SEQUENCE public.guests_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.guests_id_seq TO service_role;


--
-- Name: TABLE insights; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.insights TO anon;
GRANT ALL ON TABLE public.insights TO authenticated;
GRANT ALL ON TABLE public.insights TO service_role;


--
-- Name: SEQUENCE insights_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.insights_id_seq TO anon;
GRANT ALL ON SEQUENCE public.insights_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.insights_id_seq TO service_role;


--
-- Name: SEQUENCE qa_log_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.qa_log_id_seq TO anon;
GRANT ALL ON SEQUENCE public.qa_log_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.qa_log_id_seq TO service_role;


--
-- Name: TABLE rate_limits; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.rate_limits TO service_role;


--
-- Name: TABLE reports; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.reports TO service_role;


--
-- Name: SEQUENCE reports_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.reports_id_seq TO anon;
GRANT ALL ON SEQUENCE public.reports_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.reports_id_seq TO service_role;


--
-- Name: TABLE reviews; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.reviews TO anon;
GRANT ALL ON TABLE public.reviews TO authenticated;
GRANT ALL ON TABLE public.reviews TO service_role;


--
-- Name: SEQUENCE reviews_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.reviews_id_seq TO anon;
GRANT ALL ON SEQUENCE public.reviews_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.reviews_id_seq TO service_role;


--
-- Name: TABLE saved_items; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.saved_items TO service_role;


--
-- Name: SEQUENCE saved_items_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.saved_items_id_seq TO anon;
GRANT ALL ON SEQUENCE public.saved_items_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.saved_items_id_seq TO service_role;


--
-- Name: TABLE search_suggestions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.search_suggestions TO service_role;


--
-- Name: SEQUENCE search_suggestions_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.search_suggestions_id_seq TO anon;
GRANT ALL ON SEQUENCE public.search_suggestions_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.search_suggestions_id_seq TO service_role;


--
-- Name: TABLE segments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.segments TO anon;
GRANT ALL ON TABLE public.segments TO authenticated;
GRANT ALL ON TABLE public.segments TO service_role;


--
-- Name: SEQUENCE segments_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.segments_id_seq TO anon;
GRANT ALL ON SEQUENCE public.segments_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.segments_id_seq TO service_role;


--
-- Name: TABLE site_stats; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.site_stats TO service_role;


--
-- Name: TABLE thumbnail_features; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.thumbnail_features TO service_role;


--
-- Name: TABLE translation_segments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.translation_segments TO anon;
GRANT ALL ON TABLE public.translation_segments TO authenticated;
GRANT ALL ON TABLE public.translation_segments TO service_role;


--
-- Name: SEQUENCE translation_segments_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.translation_segments_id_seq TO anon;
GRANT ALL ON SEQUENCE public.translation_segments_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.translation_segments_id_seq TO service_role;


--
-- Name: TABLE visitor_activity; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.visitor_activity TO service_role;


--
-- Name: SEQUENCE visitors_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.visitors_id_seq TO anon;
GRANT ALL ON SEQUENCE public.visitors_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.visitors_id_seq TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- PostgreSQL database dump complete
--

\unrestrict CJl3lBF2aUryui8cgr6GjaRksQMphwb051GCSkIQqq0S4e8QW5CszNdICCcWXJh

