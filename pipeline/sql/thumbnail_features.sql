-- Ticket 23e: what each episode's YouTube thumbnail contains, measured by pipeline/17_thumbnail_features.py.
-- The thumbnails themselves are never stored or shown (CLAUDE.md rule 1); only these numbers and words are.
-- Written by the pipeline and read by the site's server (service role). Row Level Security on and no policies,
-- so the anon and authenticated roles can neither read nor write it. Run in the Supabase SQL Editor.
--
-- features (one object per episode, model_version says how it was made):
--   source            "maxres" | "hq" (which thumbnail size was analysed), width, height
--   faces             face count (OpenCV YuNet, score >= 0.75, at least 2% of the frame height)
--   largest_face      largest face box as a share of the frame area (0-1)
--   framing           "close-up" | "wide" | "none" (close-up: largest face at least 30% of the frame height)
--   text              words on the thumbnail, line by line, as written (Claude Haiku vision, strict JSON)
--   text_present, word_count, has_number, has_question, text_langs ("en", "hi", "other")
--   colours           top 3 colours [{hex, share}] (k-means on the image)
--   brightness        mean lightness 0-100 (CIELAB L); contrast: standard deviation of grey levels 0-255
--   identity          not measured (no reliable reference photos for every guest; none of the host are used)

create table if not exists public.thumbnail_features (
    episode_id     text primary key references public.episodes (video_id) on delete cascade,
    features       jsonb not null,
    model_version  text not null,
    analysed_at    timestamptz not null default now()
);

comment on table public.thumbnail_features is
    'Features of each episode''s YouTube thumbnail (faces, text, colours, brightness), from pipeline/17_thumbnail_features.py. No images are stored.';

alter table public.thumbnail_features enable row level security;
revoke all on table public.thumbnail_features from anon, authenticated;
