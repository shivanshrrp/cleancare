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
