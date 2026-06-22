-- Run once in Supabase SQL Editor if CSV import fails with:
--   duplicate key value violates unique constraint "deals_pkey"
--
-- Cause: seed data inserted explicit ids (1–208) without advancing the auto-id sequence.

create or replace function public.reset_deals_id_sequence()
returns void
language sql
security definer
set search_path = public
as $$
  select setval(
    pg_get_serial_sequence('public.deals', 'id'),
    coalesce((select max(id) from public.deals), 0) + 1,
    false
  );
$$;

select public.reset_deals_id_sequence();
