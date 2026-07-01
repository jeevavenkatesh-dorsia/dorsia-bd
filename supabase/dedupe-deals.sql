-- Remove duplicate deals, keeping the best row per venue + market.
-- Run find-duplicate-deals.sql first and review the list.
--
-- Keeps: row with latest updated_at, then highest id.
-- Deletes: all other copies in each duplicate group.

begin;

-- Preview rows that would be deleted (safe to run alone)
select d.id, d.venue, d.market, d.stage, d.updated_at
from public.deals d
join (
  select id
  from (
    select
      id,
      row_number() over (
        partition by lower(trim(venue)), lower(trim(market))
        order by updated_at desc nulls last, id desc
      ) as rn
    from public.deals
  ) ranked
  where rn > 1
) dup on dup.id = d.id
order by d.venue, d.market, d.id;

-- Uncomment the block below after reviewing the preview.
/*
delete from public.deals d
using (
  select id
  from (
    select
      id,
      row_number() over (
        partition by lower(trim(venue)), lower(trim(market))
        order by updated_at desc nulls last, id desc
      ) as rn
    from public.deals
  ) ranked
  where rn > 1
) dup
where d.id = dup.id;

-- Prevent future duplicates (run after delete succeeds)
create unique index if not exists deals_venue_market_unique
  on public.deals (lower(trim(venue)), lower(trim(market)));

select public.reset_deals_id_sequence();
*/

commit;
