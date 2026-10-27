-- Ask speed work: per-question stage timings in qa_log. Run in the Supabase SQL Editor.
-- Shape: {"stages": {"rewrite": 1200, "embed": 300, "search_en": 800, ..., "claude_ttft": 4100, "claude_total": 9000},
--         "at": {"searched": 2400, "found": 3100, "first_sentence": 7200, "answer_done": 12000, "done": 12600},
--         "tokens": {"in": 9000, "out": 400, "cache_read": 0, "cache_write": 0}}  (all times in ms)
-- Until this runs, the site saves the row without timings (the timing line is still logged by the server).

alter table public.qa_log add column if not exists timings jsonb;
