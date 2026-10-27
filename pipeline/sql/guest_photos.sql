-- Guest photos from Wikimedia Commons (pipeline/13_guest_photos.py).
-- Run in the Supabase SQL Editor. The script creates the public storage bucket guest-photos itself.
alter table public.guests add column if not exists photo_url text;      -- public copy in Supabase Storage (400 px square webp)
alter table public.guests add column if not exists photo_credit text;   -- photographer / author, plain text
alter table public.guests add column if not exists photo_license text;  -- e.g. "CC BY-SA 4.0", "CC0", "Public domain"
alter table public.guests add column if not exists photo_source text;   -- the Commons file page URL
comment on column public.guests.photo_url is
    'Only set for a freely licensed Wikimedia Commons image (CC0, public domain, CC BY, CC BY-SA); never a YouTube thumbnail.';
