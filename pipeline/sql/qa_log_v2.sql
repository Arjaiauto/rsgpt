-- Ticket 21a: qa_log columns for the Ask page. Run in the Supabase SQL Editor.
-- The site logs every question: the language it was asked in, whether the archive had an answer,
-- who asked (first name only) and how long the answer took. Until this runs, the site logs only the
-- original columns (question, answer, cited_chunk_ids, visitor_id).

alter table public.qa_log add column if not exists language    text check (language in ('en', 'hi', 'hinglish'));
alter table public.qa_log add column if not exists found       boolean;
alter table public.qa_log add column if not exists first_name  text;
alter table public.qa_log add column if not exists latency_ms  integer;

create index if not exists qa_log_created_idx on public.qa_log (created_at desc);

-- Row Level Security stays on with no policies: only the site's server (service role) reads or writes it.
alter table public.qa_log enable row level security;
revoke all on table public.qa_log from anon, authenticated;
