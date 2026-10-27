-- Ticket 19b: error reports from the site ("Report an error" popup).
-- Written only by the site's server (service role). Row Level Security on and no policies,
-- so the anon and authenticated roles can neither read nor write it.

create table if not exists public.reports (
    id          bigint generated always as identity primary key,
    item_type   text not null check (item_type in ('clip', 'episode', 'answer', 'insight', 'brief', 'guest')),
    item_id     text not null,
    video_id    text references public.episodes (video_id) on delete set null,
    start_s     double precision,
    reason      text not null check (reason in ('Wrong timestamp', 'Wrong speaker', 'Wrong fact or quote',
                                                'Transcript error', 'Something else')),
    note        text check (note is null or char_length(note) <= 280),
    first_name  text not null,
    visitor_id  text,
    page        text,
    created_at  timestamptz not null default now(),
    status      text not null default 'new'
);

create index if not exists reports_status_created_idx on public.reports (status, created_at desc);

comment on table public.reports is
    'Error reports sent from the site: item, moment, reason, optional note, first name and visitor id. Review queue.';

alter table public.reports enable row level security;
revoke all on table public.reports from anon, authenticated;
