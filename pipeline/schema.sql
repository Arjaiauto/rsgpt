-- RSGPT database schema for Supabase Postgres.
--
-- Run once in the Supabase SQL editor. Safe to run again: every statement uses
-- "if not exists", so existing tables and their data are left alone (a changed
-- column definition is NOT applied to a table that already exists).
--
-- Row Level Security is enabled on every table and no policies are created, so
-- the public anon key can read and write nothing. Only the service role (the
-- pipeline scripts and the website's server code) can, because it bypasses RLS.

create extension if not exists vector with schema extensions;


-- ---------- episodes ----------

create table if not exists public.episodes (
    video_id          text primary key,
    title             text not null,
    published_at      timestamptz,
    duration_seconds  integer,
    view_count        bigint,
    like_count        bigint,
    comment_count     bigint,
    url               text,
    caption_language  text,
    in_test_set       boolean not null default false,
    status            text
);
comment on table public.episodes is
    'One row per Figuring Out YouTube episode: metadata, caption language, test-set flag and pipeline status.';


-- ---------- segments ----------

create table if not exists public.segments (
    id             bigint generated always as identity primary key,
    video_id       text not null references public.episodes (video_id) on delete cascade,
    seq            integer not null,
    start_s        double precision not null,
    end_s          double precision not null,
    speaker        text not null default 'unknown' check (speaker in ('raj', 'guest', 'unknown')),
    text_original  text not null,
    text_roman     text not null,
    source         text not null check (source in ('youtube_auto', 'groq', 'sarvam')),
    unique (video_id, seq)
);
comment on table public.segments is
    'Timed transcript lines per episode, in original script and Roman script (identical for English episodes). Segment IDs are what every claim on the site points back to.';


-- ---------- translation_segments ----------

create table if not exists public.translation_segments (
    id        bigint generated always as identity primary key,
    video_id  text not null references public.episodes (video_id) on delete cascade,
    start_s   double precision not null,
    end_s     double precision not null,
    text      text not null
);
create index if not exists translation_segments_video_idx on public.translation_segments (video_id, start_s);
comment on table public.translation_segments is
    'YouTube''s automatic English translation of Hindi episodes, timed lines; Hindi episodes only.';


-- ---------- chunks ----------

create table if not exists public.chunks (
    id            bigint generated always as identity primary key,
    video_id      text not null references public.episodes (video_id) on delete cascade,
    start_s       double precision not null,
    end_s         double precision not null,
    text          text not null,
    published_at  timestamptz,
    embedding     extensions.vector(512),
    text_search   tsvector generated always as (to_tsvector('simple', coalesce(text, ''))) stored
);
create index if not exists chunks_video_idx on public.chunks (video_id, start_s);
create index if not exists chunks_text_search_idx on public.chunks using gin (text_search);
create index if not exists chunks_embedding_idx on public.chunks
    using hnsw (embedding extensions.vector_cosine_ops);
comment on table public.chunks is
    'Retrieval chunks of transcript text with a 512-dimension embedding (vector search) and a simple-config tsvector (keyword search) for question answering.';


-- ---------- guests ----------

create table if not exists public.guests (
    id                   bigint generated always as identity primary key,
    name                 text not null,
    organisation         text,
    role_at_episode      text,
    sector_tags          text[],
    bio                  text,
    linkedin_url         text,
    linkedin_verified    boolean not null default false,
    youtube_channel_url  text,
    video_id             text references public.episodes (video_id) on delete cascade,
    model                text,
    run_id               text
);
create index if not exists guests_video_idx on public.guests (video_id);
comment on table public.guests is
    'Guests per episode as extracted by the model. Contact data is limited to verified LinkedIn and YouTube channel links; never phone numbers or emails.';


-- ---------- insights ----------

create table if not exists public.insights (
    id                  bigint generated always as identity primary key,
    video_id            text not null references public.episodes (video_id) on delete cascade,
    guest_id            bigint references public.guests (id) on delete set null,
    type                text not null check (type in
                            ('takeaway', 'opportunity', 'quote', 'disagreement', 'raj_opinion', 'raj_question')),
    category            text check (category in
                            ('growing_sectors', 'business_ideas', 'market_gaps', 'underrated_skills',
                             'career_paths', 'investment_themes', 'hiring_signals', 'policy_shifts',
                             'geographic_opportunities', 'tools_and_tech', 'contrarian_takes',
                             'resources', 'warnings')),
    text                text not null,
    start_s             double precision,
    end_s               double precision,
    source_segment_ids  integer[],
    translated          boolean not null default false,
    verified            boolean not null default false,
    check_notes         text,
    model               text,
    run_id              text
);
create index if not exists insights_video_idx on public.insights (video_id);
create index if not exists insights_type_category_idx on public.insights (type, category);
comment on table public.insights is
    'Model-extracted takeaways, opportunities, quotes, disagreements and Raj''s opinions/questions, each traced to transcript segment IDs and timestamps. Only verified rows are shown on the site.';


-- ---------- clips ----------

create table if not exists public.clips (
    id            bigint generated always as identity primary key,
    video_id      text not null references public.episodes (video_id) on delete cascade,
    start_s       double precision not null,
    end_s         double precision not null,
    opening_line  text,
    topic         text,
    score         double precision,
    verified      boolean not null default false,
    model         text,
    run_id        text
);
create index if not exists clips_video_idx on public.clips (video_id);
comment on table public.clips is
    'Candidate short clips (time ranges) picked by the model, with a score; only verified clips are shown.';


-- ---------- reviews ----------

create table if not exists public.reviews (
    id          bigint generated always as identity primary key,
    item_table  text not null,
    item_id     bigint not null,
    verdict     text not null check (verdict in ('correct', 'wrong', 'unsure')),
    note        text,
    created_at  timestamptz not null default now()
);
create index if not exists reviews_item_idx on public.reviews (item_table, item_id);
comment on table public.reviews is
    'Manual review verdicts on rows in other tables (for example insights or clips), used to decide what is verified.';


-- ---------- feedback ----------

create table if not exists public.feedback (
    id          bigint generated always as identity primary key,
    page        text not null,
    item_id     bigint,
    note        text,
    visitor_id  text,
    created_at  timestamptz not null default now()
);
comment on table public.feedback is
    'Notes left by website visitors about a page or an item on it.';


-- ---------- qa_log ----------

create table if not exists public.qa_log (
    id               bigint generated always as identity primary key,
    question         text not null,
    answer           text,
    cited_chunk_ids  integer[],
    visitor_id       text,
    created_at       timestamptz not null default now()
);
comment on table public.qa_log is
    'Log of questions asked on the website, the answers given and the chunk IDs they cited.';


-- ---------- Row Level Security: on everywhere, no policies ----------

alter table public.episodes             enable row level security;
alter table public.segments             enable row level security;
alter table public.translation_segments enable row level security;
alter table public.chunks               enable row level security;
alter table public.guests               enable row level security;
alter table public.insights             enable row level security;
alter table public.clips                enable row level security;
alter table public.reviews              enable row level security;
alter table public.feedback             enable row level security;
alter table public.qa_log               enable row level security;
