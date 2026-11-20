-- CleanCare: run this once in Supabase → SQL Editor → New query → Run.

create table if not exists public.bags (
  id               text primary key,                       -- e.g. CL-CCC-01234
  clinic           text not null,                          -- clinic code: CCC, MSD, HPC, DRD
  category         text not null check (category in ('Yellow', 'Red', 'White', 'Blue')),
  weight           numeric(8, 2) not null check (weight > 0),
  logged_at        timestamptz not null default now(),
  status           text not null default 'logged' check (status in ('logged', 'collected')),
  collector_weight numeric(8, 2) check (collector_weight > 0),
  collected_at     timestamptz
);

-- DEMO ACCESS: anyone with the site link can read, add and update bags, but not delete them.
-- The admin's "Reset Demo" deletes through the classify-waste edge function (service role), and only sample bags.
-- Before real clinic data: Supabase Auth plus per-role policies (clinic writes its own bags, collector/facility
-- only their step).
alter table public.bags enable row level security;

drop policy if exists "demo read"   on public.bags;
drop policy if exists "demo insert" on public.bags;
drop policy if exists "demo update" on public.bags;
drop policy if exists "demo delete" on public.bags;

create policy "demo read"   on public.bags for select to anon using (true);
create policy "demo insert" on public.bags for insert to anon with check (true);
create policy "demo update" on public.bags for update to anon using (true) with check (true);

-- Push changes to open pages instantly (realtime)
do $$
begin
  alter publication supabase_realtime add table public.bags;
exception when duplicate_object then null;
end $$;

-- Journey stages after pickup (optional; older bags leave them empty). Safe to re-run.
alter table public.bags
  add column if not exists collector_id     text,
  add column if not exists vehicle_id       text,
  add column if not exists in_transit_at    timestamptz,
  add column if not exists received_at      timestamptz,
  add column if not exists received_weight  numeric(8, 2) check (received_weight > 0),
  add column if not exists facility         text,
  add column if not exists treated_at       timestamptz,
  add column if not exists treatment_method text,
  add column if not exists certificate_ref  text;

-- How the bag colour was chosen at the clinic: 'camera-assisted' or 'manual' (display only). Safe to re-run.
alter table public.bags
  add column if not exists selection_method text check (selection_method in ('camera-assisted', 'manual'));

-- Chain of custody: every handover as a timestamped event, in order. Safe to re-run.
-- Each event: {"step": "logged" | "collected" | "in_transit" | "received" | "treated",
--              "at": timestamp, "role": "clinic" | "collector" | "facility", "actor": ID or name,
--              "weight": kg (logged, collected, received), plus "vehicle" / "method" / "certificate"}
alter table public.bags
  add column if not exists events jsonb not null default '[]'::jsonb;

-- Build the history for bags saved before this column existed, from their stage columns
update public.bags b set events = (
  select coalesce(jsonb_agg(e order by (e->>'at')::timestamptz), '[]'::jsonb) from (
    select jsonb_build_object('step', 'logged', 'at', b.logged_at, 'role', 'clinic', 'actor', b.clinic, 'weight', b.weight) as e
    union all select jsonb_strip_nulls(jsonb_build_object('step', 'collected', 'at', b.collected_at, 'role', 'collector', 'actor', b.collector_id, 'weight', b.collector_weight)) where b.collected_at is not null
    union all select jsonb_strip_nulls(jsonb_build_object('step', 'in_transit', 'at', b.in_transit_at, 'role', 'collector', 'actor', b.collector_id, 'vehicle', b.vehicle_id)) where b.in_transit_at is not null
    union all select jsonb_strip_nulls(jsonb_build_object('step', 'received', 'at', b.received_at, 'role', 'facility', 'actor', b.facility, 'weight', b.received_weight)) where b.received_at is not null
    union all select jsonb_strip_nulls(jsonb_build_object('step', 'treated', 'at', b.treated_at, 'role', 'facility', 'actor', b.facility, 'method', b.treatment_method, 'certificate', b.certificate_ref)) where b.treated_at is not null
  ) x
)
where b.events = '[]'::jsonb;

-- Reward points: clinics spend points on supplies. Points themselves are never stored; the app works them
-- out from each bag's events. This table only records what was redeemed. Safe to re-run.
create table if not exists public.redemptions (
  id           uuid primary key default gen_random_uuid(),
  clinic       text not null,                       -- clinic code, e.g. SPL
  item         text not null,                       -- catalogue key: cotton, gauze, syringes, gloves, medkit
  points       integer not null check (points > 0),
  requested_at timestamptz not null default now(),
  status       text not null default 'Requested'
);

-- DEMO ACCESS, same as bags: anyone with the site link can read, add and update redemptions; no deletes.
alter table public.redemptions enable row level security;
drop policy if exists "demo read"   on public.redemptions;
drop policy if exists "demo insert" on public.redemptions;
drop policy if exists "demo update" on public.redemptions;
drop policy if exists "demo delete" on public.redemptions;
create policy "demo read"   on public.redemptions for select to anon using (true);
create policy "demo insert" on public.redemptions for insert to anon with check (true);
create policy "demo update" on public.redemptions for update to anon using (true) with check (true);

do $$
begin
  alter publication supabase_realtime add table public.redemptions;
exception when duplicate_object then null;
end $$;

-- DATA RULES THE DATABASE ENFORCES (2.1.3), whoever writes: the app, the raw API or a script.
-- Safe to re-run. Tests: supabase/guard-test.sql (runs in a transaction that is always rolled back).
--   * Bag IDs look like CL-HPC-02448 and carry the bag's own clinic code; events is always a list.
--   * A bag's ID, clinic, logging time and logged weight never change.
--   * Each handover is written once: collected / in transit / received / treated can't be changed or undone.
--   * History only grows: every earlier event must still be there with the same step, time and weight.
--   * New weights are at most 50 kg (bags already stored are left as they are).
alter table public.bags drop constraint if exists bags_id_format;
alter table public.bags add constraint bags_id_format check (id ~ '^CL-[A-Z]{3}-[0-9]{5}$' and substr(id, 4, 3) = clinic);
alter table public.bags drop constraint if exists bags_events_array;
alter table public.bags add constraint bags_events_array check (jsonb_typeof(events) = 'array');
alter table public.redemptions drop constraint if exists redemptions_clinic_format;
alter table public.redemptions add constraint redemptions_clinic_format check (clinic ~ '^[A-Z]{3}$');

create or replace function public.bags_guard() returns trigger language plpgsql as $$
declare
  max_kg constant numeric := 50;
begin
  if tg_op = 'INSERT' then
    if new.weight > max_kg then
      raise exception 'A bag can weigh at most % kg', max_kg using errcode = '23514';
    end if;
    return new;
  end if;
  if new.id <> old.id or new.clinic <> old.clinic or new.logged_at <> old.logged_at or new.weight <> old.weight then
    raise exception 'A bag''s ID, clinic, logging time and logged weight cannot change' using errcode = '23514';
  end if;
  if (old.status = 'collected' and new.status <> 'collected')
     or (old.collected_at     is not null and new.collected_at     is distinct from old.collected_at)
     or (old.collector_weight is not null and new.collector_weight is distinct from old.collector_weight)
     or (old.in_transit_at    is not null and new.in_transit_at    is distinct from old.in_transit_at)
     or (old.received_at      is not null and new.received_at      is distinct from old.received_at)
     or (old.received_weight  is not null and new.received_weight  is distinct from old.received_weight)
     or (old.treated_at       is not null and new.treated_at       is distinct from old.treated_at) then
    raise exception 'A recorded handover cannot be changed or undone' using errcode = '23514';
  end if;
  if (new.collector_weight is distinct from old.collector_weight and new.collector_weight > max_kg)
     or (new.received_weight is distinct from old.received_weight and new.received_weight > max_kg) then
    raise exception 'A bag can weigh at most % kg', max_kg using errcode = '23514';
  end if;
  -- Compared by value, not order: sample data has fixed clock times, so a new event can sort before older ones
  if exists (
    select 1 from jsonb_array_elements(old.events) o
    where not exists (
      select 1 from jsonb_array_elements(new.events) n
      where n->>'step' = o->>'step'
        and (n->>'at')::timestamptz = (o->>'at')::timestamptz
        and (n->>'weight')::numeric is not distinct from (o->>'weight')::numeric)) then
    raise exception 'Bag history can only be added to' using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists bags_guard on public.bags;
create trigger bags_guard before insert or update on public.bags
  for each row execute function public.bags_guard();
