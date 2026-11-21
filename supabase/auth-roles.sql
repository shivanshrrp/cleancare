-- REAL SIGN-IN AND PER-ROLE ACCESS (2.4.0). Safe to re-run; supabase-setup.sql runs the same rules for a fresh project.
-- People sign in with Supabase Auth (email + password). Each account has one row in public.profiles saying what it
-- may do. The database enforces it, whoever writes: the app, the raw API or a script.
--   clinic     reads bags; logs new bags for its own clinic only; requests redemptions for its own clinic
--   collector  reads bags; records pickup and the trip (not arrival at the CBWTF or treatment)
--   admin      everything (municipal officer, CBWTF staff, the team)
-- Nobody signed out can read or write anything once supabase/auth-cutover.sql has run.

create table if not exists public.profiles (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  role         text not null check (role in ('clinic', 'collector', 'admin')),
  name         text not null,
  clinic       text check (clinic ~ '^[A-Z]{3}$'),          -- the clinic's 3-letter code, for role clinic
  collector_id text,                                       -- e.g. COL-02, for role collector
  check (role <> 'clinic' or clinic is not null)
);
alter table public.profiles enable row level security;
drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles for select to authenticated using (user_id = auth.uid());
-- Profiles are created by the team in the SQL Editor (see README), never by the app.

-- Who is asking. security definer so the policies can read profiles without opening the table to everyone.
create or replace function public.my_role() returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where user_id = auth.uid()
$$;
create or replace function public.my_clinic() returns text language sql stable security definer set search_path = public as $$
  select clinic from public.profiles where user_id = auth.uid()
$$;
revoke all on function public.my_role() from public, anon;
revoke all on function public.my_clinic() from public, anon;
grant execute on function public.my_role() to authenticated;
grant execute on function public.my_clinic() to authenticated;

-- bags: everyone signed in reads (the leaderboard needs every clinic's verified weights);
-- ponytail: clinics can read other clinics' bag records; serve the leaderboard from a function if that matters.
drop policy if exists "signed-in read"     on public.bags;
drop policy if exists "clinic or admin logs" on public.bags;
drop policy if exists "collector or admin updates" on public.bags;
create policy "signed-in read" on public.bags for select to authenticated using (public.my_role() is not null);
create policy "clinic or admin logs" on public.bags for insert to authenticated
  with check (public.my_role() = 'admin' or (public.my_role() = 'clinic' and clinic = public.my_clinic()));
create policy "collector or admin updates" on public.bags for update to authenticated
  using (public.my_role() in ('collector', 'admin')) with check (public.my_role() in ('collector', 'admin'));

-- redemptions: a clinic sees and requests its own; an admin sees all and updates status
drop policy if exists "own or admin read" on public.redemptions;
drop policy if exists "clinic or admin requests" on public.redemptions;
drop policy if exists "admin updates" on public.redemptions;
create policy "own or admin read" on public.redemptions for select to authenticated
  using (public.my_role() = 'admin' or clinic = public.my_clinic());
create policy "clinic or admin requests" on public.redemptions for insert to authenticated
  with check (public.my_role() = 'admin' or (public.my_role() = 'clinic' and clinic = public.my_clinic()));
create policy "admin updates" on public.redemptions for update to authenticated
  using (public.my_role() = 'admin') with check (public.my_role() = 'admin');

-- Role limits inside a write, added to the custody guard (only for signed-in users; the server's own role is exempt)
create or replace function public.bags_role_guard() returns trigger language plpgsql as $$
declare
  r text := public.my_role();
begin
  if r = 'clinic' and tg_op = 'INSERT' and (new.status <> 'logged' or new.collected_at is not null or new.in_transit_at is not null
      or new.received_at is not null or new.treated_at is not null) then
    raise exception 'A clinic can only log a new bag' using errcode = '42501';
  end if;
  if r = 'collector' and tg_op = 'UPDATE' and (new.received_at is distinct from old.received_at
      or new.received_weight is distinct from old.received_weight or new.treated_at is distinct from old.treated_at
      or new.facility is distinct from old.facility or new.treatment_method is distinct from old.treatment_method
      or new.certificate_ref is distinct from old.certificate_ref) then
    raise exception 'Only the treatment facility records arrival and treatment' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists bags_role_guard on public.bags;
create trigger bags_role_guard before insert or update on public.bags
  for each row execute function public.bags_role_guard();
