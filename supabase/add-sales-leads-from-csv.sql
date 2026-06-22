-- Add Attio Business Partners as sales leads (keeps existing pipeline names).
-- Run once in Supabase → SQL Editor.

update public.app_settings
set value = (
  select coalesce(jsonb_agg(distinct x order by x), '[]'::jsonb)
  from (
    select jsonb_array_elements_text(value) as x
    from public.app_settings
    where key = 'sales_leads'
    union select 'Anouschka Rao'::text
    union select 'Courtney Adams'::text
    union select 'Josh Mendel'::text
    union select 'Marc Lotenburg'::text
    union select 'Steffi Klein'::text
    union select 'Andrew Goldberg'::text
    union select 'Ava Dagres'::text
    union select 'Blakely Byrd'::text
    union select 'Courtney Kringstein'::text
    union select 'Gaby'::text
    union select 'Gaby Espejo'::text
    union select 'Jordan Okun'::text
    union select 'Joshua Stern'::text
    union select 'Knox Dobbins'::text
    union select 'Marc L'::text
    union select 'Melissa Crane-Baker'::text
    union select 'Natalia Bojanowicz'::text
    union select 'Peter Gosik'::text
    union select 'Radhika Bansil'::text
    union select 'Sasha Lambrecht'::text
    union select 'Stefanie Bobinger'::text
  ) s
),
updated_at = now()
where key = 'sales_leads';

-- If sales_leads row doesn't exist yet:
insert into public.app_settings (key, value)
select 'sales_leads', '[
  "Anouschka Rao","Andrew Goldberg","Ava Dagres","Blakely Byrd",
  "Courtney Adams","Courtney Kringstein","Gaby","Gaby Espejo",
  "Jordan Okun","Josh Mendel","Joshua Stern","Knox Dobbins",
  "Marc L","Marc Lotenburg","Melissa Crane-Baker","Natalia Bojanowicz",
  "Peter Gosik","Radhika Bansil","Sasha Lambrecht","Stefanie Bobinger","Steffi Klein"
]'::jsonb
where not exists (select 1 from public.app_settings where key = 'sales_leads');
