-- SWITCH-OVER: remove signed-out access. Run only after supabase/auth-roles.sql, after the team's accounts and profiles
-- exist, and after the app that signs in with Supabase Auth (2.4.0) is live. Before this, the old open policies stay.
drop policy if exists "demo read"   on public.bags;
drop policy if exists "demo insert" on public.bags;
drop policy if exists "demo update" on public.bags;
drop policy if exists "demo read"   on public.redemptions;
drop policy if exists "demo insert" on public.redemptions;
drop policy if exists "demo update" on public.redemptions;
