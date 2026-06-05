create table if not exists control.health_check_state (
    check_name text primary key,
    last_run_at timestamptz not null,
    last_status text not null check (last_status in ('ok', 'warning', 'critical', 'stub')),
    detail_message text,
    updated_at timestamptz default now() not null
);

comment on table control.health_check_state is
  'SystemHealthEvaluator writes each check state every 5 minutes for UI dashboard cards.';

insert into control.health_check_state (check_name, last_run_at, last_status, detail_message)
values
  ('stat_collection', now(), 'ok', 'henuz calistirilmadi'),
  ('partition_missing', now(), 'ok', 'henuz calistirilmadi'),
  ('instance_unreachable', now(), 'ok', 'henuz calistirilmadi'),
  ('collector_stale', now(), 'ok', 'henuz calistirilmadi'),
  ('cleanup_failed', now(), 'stub', 'henuz implement edilmedi'),
  ('disk_full', now(), 'ok', 'reactive - DB hatasi yakalandiginda tetiklenir')
on conflict (check_name) do nothing;
