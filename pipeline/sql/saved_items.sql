-- Ticket 21b: things people save on the site (a clip from any player, an Ask answer, later a prep brief).
-- Written and read only by the site's server (service role). Row Level Security on and no policies,
-- so the anon and authenticated roles can neither read nor write it. Run in the Supabase SQL Editor.
--
-- item_ref by kind:
--   clip   {"videoId", "startS", "endS", "title", "guest", "episode", "date"}
--   answer {"question", "answer", "citations": [{"videoId", "startS", "endS", "segmentIds", "speaker", "date", "episode", "guest"}]}
--   brief  free for now (Ticket 23)

create table if not exists public.saved_items (
    id          bigint generated always as identity primary key,
    visitor_id  text,
    first_name  text not null,
    kind        text not null check (kind in ('clip', 'answer', 'brief')),
    item_ref    jsonb not null,
    folder      text,
    note        text check (note is null or char_length(note) <= 500),
    created_at  timestamptz not null default now()
);

create index if not exists saved_items_visitor_created_idx on public.saved_items (visitor_id, created_at desc);

comment on table public.saved_items is
    'Clips, answers and briefs saved from the site: who (visitor id and first name), what (kind + item_ref), optional folder and note.';

alter table public.saved_items enable row level security;
revoke all on table public.saved_items from anon, authenticated;
