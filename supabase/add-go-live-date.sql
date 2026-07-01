-- Add go-live date for onboarded / live restaurants.
-- Run once in Supabase SQL Editor.

alter table public.deals
  add column if not exists go_live_date text not null default '';
