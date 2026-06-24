-- Partner / external BD users: allow their email domain so RLS returns deals.
-- Symptom when missing: user can sign in, but Dashboard / Pipeline / Deals all show 0 deals.

-- 1) See current allowlist
select key, value from public.app_settings where key = 'allowed_email_domains';

-- 2) Add ASG Hospitality (keeps any domains already configured)
update public.app_settings
set value = (
  select coalesce(jsonb_agg(distinct d), '[]'::jsonb)
  from (
    select jsonb_array_elements_text(value) as d
    from public.app_settings
    where key = 'allowed_email_domains'
    union all
    select 'asghospitality.com'
  ) domains
)
where key = 'allowed_email_domains';

-- 3) Access-check helper used by the app (safe to re-run)
create or replace function public.get_access_status()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'allowed', public.is_bd_user(),
    'email', coalesce(auth.jwt()->>'email', '')
  );
$$;

grant execute on function public.get_access_status() to authenticated;
