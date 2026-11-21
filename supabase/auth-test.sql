-- Checks the per-role rules in supabase/auth-roles.sql by acting as each kind of user. It ends by raising
-- "ALL n ROLE CHECKS PASSED", which rolls everything back, so nothing is kept. Any other error names the failed check.
do $$
declare
  u_clinic uuid := '00000000-0000-0000-0000-0000000000c1';
  u_coll   uuid := '00000000-0000-0000-0000-0000000000c2';
  u_admin  uuid := '00000000-0000-0000-0000-0000000000c3';
  u_none   uuid := '00000000-0000-0000-0000-0000000000c4';  -- signed in, but no profile
  ev text := '[{"step":"logged","at":"2026-11-21T08:00:00Z","weight":2}]';
  -- who, statement, expected: ok (writes or reads rows), none (runs but touches no row), fail (refused)
  cases text[][] := array[
    ['clinic', $q$insert into public.bags (id, clinic, category, weight, logged_at, events) values ('CL-CCC-90001','CCC','Red',2,'2026-11-21T08:00:00Z','$q$ || ev || $q$')$q$, 'ok', 'clinic logs a bag for its own clinic'],
    ['clinic', $q$insert into public.bags (id, clinic, category, weight, events) values ('CL-HPC-90002','HPC','Red',2,'[]')$q$, 'fail', 'clinic cannot log for another clinic'],
    ['clinic', $q$insert into public.bags (id, clinic, category, weight, status, collected_at, events) values ('CL-CCC-90003','CCC','Red',2,'collected',now(),'[]')$q$, 'fail', 'clinic cannot log a bag as already collected'],
    ['clinic', $q$select * from public.bags where id = 'CL-CCC-90001'$q$, 'ok', 'clinic can read bags'],
    ['clinic', $q$update public.bags set status = 'collected', collected_at = now() where id = 'CL-CCC-90001'$q$, 'none', 'clinic cannot update a bag'],
    ['clinic', $q$insert into public.redemptions (clinic, item, points) values ('CCC','gloves',100)$q$, 'ok', 'clinic requests a redemption for itself'],
    ['clinic', $q$insert into public.redemptions (clinic, item, points) values ('HPC','gloves',100)$q$, 'fail', 'clinic cannot request for another clinic'],
    ['collector', $q$update public.bags set status = 'collected', collected_at = '2026-11-21T09:00:00Z', collector_weight = 2, events = events || '[{"step":"collected","at":"2026-11-21T09:00:00Z","weight":2}]' where id = 'CL-CCC-90001'$q$, 'ok', 'collector records a pickup'],
    ['collector', $q$update public.bags set received_at = '2026-11-21T10:00:00Z', received_weight = 2 where id = 'CL-CCC-90001'$q$, 'fail', 'collector cannot record arrival at the CBWTF'],
    ['collector', $q$insert into public.bags (id, clinic, category, weight, events) values ('CL-CCC-90004','CCC','Red',2,'[]')$q$, 'fail', 'collector cannot log bags'],
    ['collector', $q$select * from public.redemptions where clinic = 'CCC'$q$, 'none', 'collector cannot see redemptions'],
    ['admin', $q$update public.bags set received_at = '2026-11-21T10:00:00Z', received_weight = 2, facility = 'Test CBWTF', events = events || '[{"step":"received","at":"2026-11-21T10:00:00Z","weight":2}]' where id = 'CL-CCC-90001'$q$, 'ok', 'admin records arrival'],
    ['admin', $q$update public.redemptions set status = 'Approved' where clinic = 'CCC'$q$, 'ok', 'admin approves a redemption'],
    ['admin', $q$delete from public.bags where id = 'CL-CCC-90001'$q$, 'none', 'even an admin cannot delete through the app'],
    ['noprofile', $q$select * from public.bags$q$, 'none', 'a signed-in account without a profile sees nothing'],
    ['noprofile', $q$insert into public.bags (id, clinic, category, weight, events) values ('CL-CCC-90005','CCC','Red',2,'[]')$q$, 'fail', 'a signed-in account without a profile cannot write'],
    ['anon', $q$select * from public.bags$q$, 'none', 'signed-out visitors see nothing']
  ];
  c text[]; n int := 0; rc int; failed boolean;
begin
  insert into auth.users (id, email) values (u_clinic, 'c1@test'), (u_coll, 'c2@test'), (u_admin, 'c3@test'), (u_none, 'c4@test');
  insert into public.profiles (user_id, role, name, clinic, collector_id) values
    (u_clinic, 'clinic', 'City Care Clinic', 'CCC', null), (u_coll, 'collector', 'Ravi', null, 'COL-02'), (u_admin, 'admin', 'Officer', null, null);
  foreach c slice 1 in array cases loop
    perform set_config('request.jwt.claim.sub', case c[1] when 'clinic' then u_clinic::text when 'collector' then u_coll::text
      when 'admin' then u_admin::text when 'noprofile' then u_none::text else '' end, true);
    execute case when c[1] = 'anon' then 'set local role anon' else 'set local role authenticated' end;
    failed := false; rc := 0;
    begin
      execute c[2];
      get diagnostics rc = row_count;
    exception when insufficient_privilege or check_violation then failed := true;
    end;
    reset role;
    if (c[3] = 'fail') <> failed or (c[3] = 'ok' and rc = 0) or (c[3] = 'none' and rc > 0) then
      raise exception 'ROLE CHECK FAILED: % (failed=%, rows=%)', c[4], failed, rc;
    end if;
    n := n + 1;
    raise notice 'ok  %', c[4];
  end loop;
  raise exception 'ALL % ROLE CHECKS PASSED (rolled back, nothing kept)', n;
end $$;
