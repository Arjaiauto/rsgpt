-- Ticket 22: what kind of request a qa_log row is. Run in the Supabase SQL Editor.
-- 'ask' is a question on the Ask page (every row so far); 'brief' is a Prep brief that was built.
-- For a brief, `question` is "name - one-line description" (or the sector), `answer` the brief as text and
-- `cited_chunk_ids` the passages the brief's cited lines point at.
-- Until this runs, the site still logs a brief, but as an ordinary row whose question starts with "[brief] ".

alter table public.qa_log add column if not exists kind text not null default 'ask' check (kind in ('ask', 'brief'));

create index if not exists qa_log_kind_created_idx on public.qa_log (kind, created_at desc);
