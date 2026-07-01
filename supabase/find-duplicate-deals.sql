-- Find duplicate deals (same restaurant + market).
-- The app treats venue + market as one deal. Same name in a *different* market is OK.

-- 1) Summary: how many duplicate groups?
select
  count(*) as duplicate_groups,
  coalesce(sum(cnt - 1), 0) as extra_rows_to_remove
from (
  select count(*) as cnt
  from public.deals
  group by lower(trim(venue)), lower(trim(market))
  having count(*) > 1
) d;

-- 2) List every duplicate group (newest row kept on cleanup)
select
  lower(trim(venue)) as venue_key,
  lower(trim(market)) as market_key,
  count(*) as copies,
  min(venue) as sample_venue,
  min(market) as sample_market,
  array_agg(id order by updated_at desc, id desc) as ids_newest_first
from public.deals
group by lower(trim(venue)), lower(trim(market))
having count(*) > 1
order by copies desc, venue_key;

-- 3) Optional: same venue name in multiple markets (usually valid, not duplicates)
-- select lower(trim(venue)) as venue_key, count(distinct lower(trim(market))) as markets, count(*) as rows
-- from public.deals
-- group by lower(trim(venue))
-- having count(*) > 1
-- order by rows desc;
