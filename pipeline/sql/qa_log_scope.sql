-- Ticket 28d: which part of the archive an Ask question searched. NOT RUN YET. Run in the Supabase SQL Editor (safe
-- to run twice). Until it runs, the site logs scoped questions without it (it retries the insert without the column).
--
--   qa_log.scope   NULL for a question over the whole archive. Otherwise the chips the reader picked, the label the
--                  site showed and the number of episodes searched, e.g.
--                  {"topic": "health", "year": 2025, "lang": "hi", "label": "Health · 2025 · Hindi", "episodes": 23}
--                  or {"guest": "vaibhav-sisinty", "label": "Vaibhav Sisinty", "episodes": 6}

begin;

alter table public.qa_log add column if not exists scope jsonb;

comment on column public.qa_log.scope is
    'Ask within a scope (Ticket 28d): null = the whole archive; else {guest?, topic?, year?, lang?, label, episodes}.';

create index if not exists qa_log_scoped_idx on public.qa_log (created_at desc) where scope is not null;

commit;

-- ---------- check ----------
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'qa_log' and column_name = 'scope';
