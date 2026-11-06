-- Ticket 28a: thumbs up / down on answers (and Prep briefs). NOT RUN YET. Run in the Supabase SQL Editor (safe to run twice).
--
--   answer_feedback       one row per (qa_log row, person): rating 'up' or 'down', plus an optional one-line "what was
--                         wrong" (only kept with a 'down'). Voting again changes the row instead of adding one.
--   set_answer_feedback   the one function the site calls (service role): inserts or changes the person's vote.
--   answer_feedback_view  for the Table Editor: one line per vote with the question, a short answer excerpt, whether it
--                         was found, the kind (ask / brief) and whether the voter is a test name.
--
-- Depends on visitors_events.sql (visitors, set_visitor_ref, is_test_name) and qa_log_kind.sql (qa_log.kind).
-- A trigger fills visitor_ref from first_name, the same one qa_log / saved_items / reports use.
-- Row Level Security on, no policies, nothing for anon / authenticated (the site's server uses the service role).
-- visitor_activity is not touched (it may have changed since visitors_events.sql); counts per person are in the view's
-- sibling query at the bottom.
--
-- One transaction: all or nothing. Idempotent: IF NOT EXISTS for tables / indexes, CREATE OR REPLACE for the function
-- and view, the trigger is dropped and recreated.

begin;

create table if not exists public.answer_feedback (
    id          bigint generated always as identity primary key,
    qa_log_id   bigint      not null references public.qa_log (id) on delete cascade,
    rating      text        not null check (rating in ('up', 'down')),
    note        text        check (note is null or (char_length(note) <= 200 and rating = 'down')),
    first_name  text        not null check (btrim(first_name) <> ''),
    name_key    text        generated always as (lower(btrim(first_name))) stored,
    visitor_id  text,
    visitor_ref bigint      references public.visitors (id) on delete set null,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    unique (qa_log_id, name_key)
);

comment on table public.answer_feedback is
    'Thumbs up/down on an Ask answer or Prep brief (qa_log row). One vote per person per answer; changing a vote updates the row. note = the one-line "what was wrong" after a thumbs-down.';

create index if not exists answer_feedback_created_idx     on public.answer_feedback (created_at desc);
create index if not exists answer_feedback_rating_idx      on public.answer_feedback (rating, created_at desc);
create index if not exists answer_feedback_visitor_ref_idx on public.answer_feedback (visitor_ref);

alter table public.answer_feedback enable row level security;
revoke all on table public.answer_feedback from anon, authenticated;

-- Fill visitor_ref from first_name (existing trigger function; it reads new.first_name and never blocks the insert).
drop trigger if exists answer_feedback_visitor_ref on public.answer_feedback;
create trigger answer_feedback_visitor_ref before insert on public.answer_feedback
    for each row execute function public.set_visitor_ref();

-- One call per vote. p_rating 'up' | 'down' (anything else is refused); p_note is trimmed, kept only with 'down'.
-- Returns false when the qa_log row does not exist, so the site can tell the reader without an error.
create or replace function public.set_answer_feedback(
    p_qa_log_id bigint, p_first_name text, p_visitor_id text, p_rating text, p_note text)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
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

revoke all on function public.set_answer_feedback(bigint, text, text, text, text) from public, anon, authenticated;
grant execute on function public.set_answer_feedback(bigint, text, text, text, text) to service_role;

-- A readable list for the Table Editor, newest first.
create or replace view public.answer_feedback_view with (security_invoker = true) as
select f.id, f.created_at, f.updated_at, f.rating, f.note,
       f.first_name, v.is_test,
       q.kind, q.found, q.language,
       q.question,
       left(q.answer, 300) as answer_excerpt,
       q.latency_ms,
       f.qa_log_id
from public.answer_feedback f
join public.qa_log q on q.id = f.qa_log_id
left join public.visitors v on v.id = f.visitor_ref
order by f.created_at desc;

revoke all on public.answer_feedback_view from anon, authenticated;

commit;

-- ---------- check (one result: section / item / value) ----------
select 1 as n, 'answer_feedback' as section, 'rows' as item, count(*)::text as value from public.answer_feedback
union all
select 2, 'function', 'set_answer_feedback exists', (count(*) = 1)::text
from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname = 'set_answer_feedback'
union all
select 3, 'trigger', 'answer_feedback_visitor_ref exists', (count(*) = 1)::text
from pg_trigger where tgname = 'answer_feedback_visitor_ref' and not tgisinternal
order by n, item;
