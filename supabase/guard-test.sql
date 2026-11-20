-- Checks the database rules in supabase-setup.sql on a temporary copy of the bags table. Paste into the SQL
-- Editor and run: it ends by raising "ALL n CHECKS PASSED", which rolls everything back, so nothing is kept.
-- Any other error names the check that failed. Needs public.bags_guard() (run supabase-setup.sql first).
do $$
declare
  n int := 0;
  ev jsonb := '[{"step":"logged","at":"2026-11-20T08:00:00Z","weight":2}]';
begin
  create temp table t (like public.bags including all) on commit drop;
  create trigger g before insert or update on t for each row execute function public.bags_guard();

  -- expect(sql, should_fail, label)
  create temp table cases (sql text, fail boolean, label text) on commit drop;
  insert into cases values
    ($q$insert into t (id, clinic, category, weight, logged_at, events) values ('CL-HPC-00001', 'HPC', 'Red', 2, '2026-11-20T08:00:00Z', '$q$ || ev::text || $q$')$q$, false, 'new bag accepted'),
    ($q$insert into t (id, clinic, category, weight, events) values ('CL-HPC-00002', 'HPC', 'Red', 60, '[]')$q$, true, 'new bag over 50 kg refused'),
    ($q$insert into t (id, clinic, category, weight, events) values ('BAD-1', 'HPC', 'Red', 2, '[]')$q$, true, 'badly formed bag ID refused'),
    ($q$insert into t (id, clinic, category, weight, events) values ('CL-ABC-00003', 'HPC', 'Red', 2, '[]')$q$, true, 'ID with another clinic''s code refused'),
    ($q$insert into t (id, clinic, category, weight, events) values ('CL-HPC-00004', 'HPC', 'Red', 2, '{}')$q$, true, 'events that are not a list refused'),
    ($q$update t set status = 'collected', collected_at = '2026-11-20T09:00:00Z', collector_weight = 2.1,
        events = events || '[{"step":"collected","at":"2026-11-20T09:00:00Z","weight":2.1}]' where id = 'CL-HPC-00001'$q$, false, 'pickup recorded'),
    ($q$update t set collected_at = '2026-11-20T10:00:00Z' where id = 'CL-HPC-00001'$q$, true, 'pickup time can''t be changed'),
    ($q$update t set collector_weight = 1 where id = 'CL-HPC-00001'$q$, true, 'pickup weight can''t be changed'),
    ($q$update t set status = 'logged' where id = 'CL-HPC-00001'$q$, true, 'pickup can''t be undone'),
    ($q$update t set clinic = 'NPL' where id = 'CL-HPC-00001'$q$, true, 'clinic can''t be changed'),
    ($q$update t set weight = 1 where id = 'CL-HPC-00001'$q$, true, 'logged weight can''t be changed'),
    ($q$update t set events = '[]' where id = 'CL-HPC-00001'$q$, true, 'history can''t be erased'),
    ($q$update t set events = jsonb_set(events, '{0,weight}', '9') where id = 'CL-HPC-00001'$q$, true, 'a past weight in history can''t be edited'),
    ($q$update t set received_weight = 80, received_at = '2026-11-20T11:00:00Z' where id = 'CL-HPC-00001'$q$, true, 'arrival weight over 50 kg refused'),
    ($q$update t set received_at = '2026-11-20T08:30:00Z', received_weight = 2.1,
        events = '[{"step":"received","at":"2026-11-20T08:30:00Z","weight":2.1}]'::jsonb || events where id = 'CL-HPC-00001'$q$, false, 'new event sorted before older ones accepted'),
    ($q$update t set category = 'Yellow', events = events || '[{"step":"reclassified","at":"2026-11-20T11:00:00Z","from":"Red","to":"Yellow","points":-25}]' where id = 'CL-HPC-00001'$q$, false, 'colour correction with its event accepted');

  declare c record; failed boolean;
  begin
    for c in select * from cases loop
      failed := false;
      begin
        execute c.sql;
      exception when check_violation then failed := true;
      end;
      if failed <> c.fail then raise exception 'CHECK FAILED: %', c.label; end if;
      n := n + 1;
      raise notice 'ok  %', c.label;
    end loop;
  end;
  raise exception 'ALL % CHECKS PASSED (rolled back, nothing kept)', n;
end $$;
