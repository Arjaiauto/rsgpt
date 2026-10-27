-- Who speaks in a clip (pipeline/15_clip_speakers.py): the share of the clip's spoken time that the speaker labels
-- (segments.speaker) mark as the guest. The site shows a clip on a guest's page and counts it on their card only when
-- the guest is the main speaker (share of at least 0.5); a clip with no value yet is shown as before.
--
-- Run in the Supabase SQL Editor, once, then run pipeline/15_clip_speakers.py.
--
-- The script writes through set_clip_guest_share below and never inserts clips: clips.id is an identity column
-- (GENERATED ALWAYS), so an upsert that sends id is refused by Postgres.

alter table public.clips add column if not exists guest_share double precision;
comment on column public.clips.guest_share is
    'Share (0 to 1) of the clip''s spoken time labelled guest in segments.speaker; set by pipeline/15_clip_speakers.py.';

-- Sets guest_share on existing clips only, one row per pair of ids[i] and shares[i]. Ids that do not exist are
-- ignored. Returns the number of rows changed.
create or replace function public.set_clip_guest_share(ids bigint[], shares double precision[])
returns integer
language sql
set search_path = public
as $$
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

-- Only the service role (the pipeline script and the site server) may call it.
revoke all on function public.set_clip_guest_share(bigint[], double precision[]) from public, anon, authenticated;
grant execute on function public.set_clip_guest_share(bigint[], double precision[]) to service_role;
