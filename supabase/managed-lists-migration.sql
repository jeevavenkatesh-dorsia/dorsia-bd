-- Run once in Supabase SQL Editor if your project was created before managed lists were added.
insert into public.app_settings (key, value) values
  ('restaurant_groups', '[]'::jsonb),
  ('market_list', '[]'::jsonb),
  ('sales_leads', '[]'::jsonb)
on conflict (key) do nothing;
