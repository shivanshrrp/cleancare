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

-- DEMO ACCESS: anyone with the site link can read, add, update and delete bags.
-- Fine for a demo; add real sign-in before using this with live clinic data.
alter table public.bags enable row level security;

drop policy if exists "demo read"   on public.bags;
drop policy if exists "demo insert" on public.bags;
drop policy if exists "demo update" on public.bags;
drop policy if exists "demo delete" on public.bags;

create policy "demo read"   on public.bags for select to anon using (true);
create policy "demo insert" on public.bags for insert to anon with check (true);
create policy "demo update" on public.bags for update to anon using (true) with check (true);
create policy "demo delete" on public.bags for delete to anon using (true);

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

-- DEMO ACCESS, same as bags: anyone with the site link can read and add redemptions.
alter table public.redemptions enable row level security;
drop policy if exists "demo read"   on public.redemptions;
drop policy if exists "demo insert" on public.redemptions;
drop policy if exists "demo update" on public.redemptions;
drop policy if exists "demo delete" on public.redemptions;
create policy "demo read"   on public.redemptions for select to anon using (true);
create policy "demo insert" on public.redemptions for insert to anon with check (true);
create policy "demo update" on public.redemptions for update to anon using (true) with check (true);
create policy "demo delete" on public.redemptions for delete to anon using (true);

do $$
begin
  alter publication supabase_realtime add table public.redemptions;
exception when duplicate_object then null;
end $$;
