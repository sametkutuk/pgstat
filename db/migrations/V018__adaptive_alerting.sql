-- V018: Adaptive Alerting System
-- Baseline profiling, snooze, notification channels, scope management

-- ============================================================================
-- 1. BASELINE TABLES
-- ============================================================================

-- Metric baseline (genel metrikler için)
create table if not exists control.metric_baseline (
  instance_pk bigint not null references control.instance_inventory(instance_pk) on delete cascade,
  metric_key text not null,
  hour_of_day integer check (hour_of_day between 0 and 23),  -- null = genel, 0-23 = saatlik
  
  -- Tarihsel istatistikler (son 4 hafta)
  avg_value numeric,
  stddev_value numeric,
  min_value numeric,
  max_value numeric,
  p50_value numeric,
  p95_value numeric,
  p99_value numeric,
  sample_count integer,
  
  -- Kapasite bilgisi (varsa)
  capacity_value numeric,
  capacity_source text,
  
  -- Meta
  baseline_start timestamptz,
  baseline_end timestamptz,
  updated_at timestamptz default now(),
  
  primary key (instance_pk, metric_key, coalesce(hour_of_day, -1))
);

create index idx_metric_baseline_lookup on control.metric_baseline (instance_pk, metric_key, hour_of_day);
create index idx_metric_baseline_updated on control.metric_baseline (updated_at);

-- Query bazlı baseline
create table if not exists control.metric_baseline_query (
  instance_pk bigint not null references control.instance_inventory(instance_pk) on delete cascade,
  queryid bigint not null,
  statement_series_pk bigint,  -- opsiyonel
  
  -- Performans metrikleri
  avg_exec_time_ms numeric,
  stddev_exec_time_ms numeric,
  min_exec_time_ms numeric,
  max_exec_time_ms numeric,
  p95_exec_time_ms numeric,
  
  -- Çağrı metrikleri
  avg_calls_per_hour numeric,
  stddev_calls numeric,
  min_calls numeric,
  max_calls numeric,
  
  -- Temp kullanımı
  avg_temp_blks_per_call numeric,
  max_temp_blks_per_call numeric,
  
  -- Plan bilgisi (PG13+)
  current_planid bigint,
  
  -- Meta
  sample_count integer,
  baseline_start timestamptz,
  baseline_end timestamptz,
  updated_at timestamptz default now(),
  
  primary key (instance_pk, queryid)
);

create index idx_baseline_query_lookup on control.metric_baseline_query (instance_pk, queryid);

-- Instance settings (kapasite bilgileri)
create table if not exists control.instance_settings (
  instance_pk bigint primary key references control.instance_inventory(instance_pk) on delete cascade,
  max_connections integer,
  superuser_reserved integer,
  shared_buffers_bytes bigint,
  checkpoint_timeout_seconds integer,
  autovacuum_max_workers integer,
  work_mem_bytes bigint,
  pg_version text,
  updated_at timestamptz default now()
);

-- Baseline versiyonlama
create table if not exists control.baseline_version (
  version_id serial primary key,
  instance_pk bigint not null references control.instance_inventory(instance_pk) on delete cascade,
  
  version_number integer not null default 1,
  pg_version text,
  
  invalidation_reason text,
  invalidated_at timestamptz,
  invalidated_by text,
  
  baseline_start timestamptz not null,
  baseline_end timestamptz,
  
  is_active boolean default true,
  created_at timestamptz default now(),
  
  unique (instance_pk, version_number)
);

create index idx_baseline_version_active on control.baseline_version (instance_pk, is_active) where is_active = true;

-- ============================================================================
-- 2. ALERT RULE ENHANCEMENTS
-- ============================================================================

-- Instance groups
create table if not exists control.instance_group (
  group_id serial primary key,
  group_name text not null unique,
  description text,
  created_at timestamptz default now()
);

create table if not exists control.instance_group_member (
  group_id integer not null references control.instance_group(group_id) on delete cascade,
  instance_pk bigint not null references control.instance_inventory(instance_pk) on delete cascade,
  added_at timestamptz default now(),
  primary key (group_id, instance_pk)
);

-- Alert rule güncellemeleri
alter table control.alert_rule
  add column if not exists sensitivity text default 'medium' check (sensitivity in ('low', 'medium', 'high')),
  add column if not exists use_adaptive boolean default true,
  add column if not exists absolute_warning numeric,
  add column if not exists absolute_critical numeric,
  add column if not exists template_id integer,
  add column if not exists scope text default 'single_instance' check (scope in ('single_instance', 'all_instances', 'instance_group')),
  add column if not exists instance_group_id integer references control.instance_group(group_id);

-- instance_pk artık nullable (all_instances scope için)
alter table control.alert_rule alter column instance_pk drop not null;

-- Scope constraint
alter table control.alert_rule drop constraint if exists check_scope_consistency;
alter table control.alert_rule
  add constraint check_scope_consistency check (
    (scope = 'single_instance' and instance_pk is not null and instance_group_id is null) or
    (scope = 'all_instances' and instance_pk is null and instance_group_id is null) or
    (scope = 'instance_group' and instance_pk is null and instance_group_id is not null)
  );

-- ============================================================================
-- 3. ALERT SNOOZE & MAINTENANCE
-- ============================================================================

-- Alert snooze
create table if not exists control.alert_snooze (
  snooze_id serial primary key,
  
  rule_id integer references control.alert_rule(rule_id) on delete cascade,
  instance_pk bigint references control.instance_inventory(instance_pk) on delete cascade,
  metric_key text,
  queryid bigint,
  
  snooze_until timestamptz not null,
  snooze_reason text,
  
  created_by text not null,
  created_at timestamptz default now(),
  
  constraint check_snooze_scope check (
    rule_id is not null or 
    instance_pk is not null or 
    metric_key is not null or
    queryid is not null
  )
);

create index idx_alert_snooze_active on control.alert_snooze (snooze_until) where snooze_until > now();
create index idx_alert_snooze_rule on control.alert_snooze (rule_id);
create index idx_alert_snooze_instance on control.alert_snooze (instance_pk);

-- Maintenance windows
create table if not exists control.maintenance_window (
  window_id serial primary key,
  window_name text not null,
  description text,
  
  instance_pks bigint[],
  
  day_of_week integer[] check (array_length(day_of_week, 1) is null or (select bool_and(d between 0 and 6) from unnest(day_of_week) d)),
  start_time time not null,
  end_time time not null,
  timezone text default 'UTC',
  
  suppress_all_alerts boolean default true,
  suppress_severity text[],
  
  is_enabled boolean default true,
  created_at timestamptz default now()
);

-- ============================================================================
-- 4. NOTIFICATION CHANNELS
-- ============================================================================

create table if not exists control.notification_channel (
  channel_id serial primary key,
  channel_name text not null unique,
  channel_type text not null check (channel_type in ('email', 'slack', 'pagerduty', 'teams', 'webhook')),
  
  config jsonb not null,
  
  min_severity text check (min_severity in ('warning', 'critical', 'emergency')),
  instance_pks bigint[],
  metric_categories text[],
  
  is_enabled boolean default true,
  created_at timestamptz default now()
);

-- ============================================================================
-- 5. HELPER FUNCTIONS
-- ============================================================================

-- Baseline invalidation function
create or replace function control.invalidate_baseline(
  p_instance_pk bigint,
  p_reason text,
  p_invalidated_by text
) returns void as $$
begin
  -- Mevcut versiyonu kapat
  update control.baseline_version
  set is_active = false,
      baseline_end = now(),
      invalidation_reason = p_reason,
      invalidated_at = now(),
      invalidated_by = p_invalidated_by
  where instance_pk = p_instance_pk
    and is_active = true;
  
  -- Yeni versiyon başlat
  insert into control.baseline_version (instance_pk, version_number, baseline_start, pg_version)
  select p_instance_pk, 
         coalesce(max(version_number), 0) + 1,
         now(),
         (select pg_version from control.instance_settings where instance_pk = p_instance_pk)
  from control.baseline_version
  where instance_pk = p_instance_pk;
  
  -- Eski baseline verilerini sil
  delete from control.metric_baseline where instance_pk = p_instance_pk;
  delete from control.metric_baseline_query where instance_pk = p_instance_pk;
end;
$$ language plpgsql;

-- Check if alert is snoozed
create or replace function control.is_alert_snoozed(
  p_rule_id integer,
  p_instance_pk bigint,
  p_metric_key text,
  p_queryid bigint default null
) returns boolean as $$
begin
  return exists (
    select 1
    from control.alert_snooze
    where snooze_until > now()
      and (rule_id = p_rule_id or rule_id is null)
      and (instance_pk = p_instance_pk or instance_pk is null)
      and (metric_key = p_metric_key or metric_key is null)
      and (queryid = p_queryid or queryid is null)
  );
end;
$$ language plpgsql;

-- Check if in maintenance window
create or replace function control.is_in_maintenance(
  p_instance_pk bigint
) returns boolean as $$
begin
  return exists (
    select 1
    from control.maintenance_window
    where is_enabled = true
      and (instance_pks is null or p_instance_pk = any(instance_pks))
      and (day_of_week is null or extract(dow from now()) = any(day_of_week))
      and current_time between start_time and end_time
  );
end;
$$ language plpgsql;

-- ============================================================================
-- 6. SEED DATA
-- ============================================================================

-- Default instance groups
insert into control.instance_group (group_name, description)
values
  ('production', 'Production databases'),
  ('staging', 'Staging environment'),
  ('development', 'Development environment')
on conflict (group_name) do nothing;

-- Default notification channel (email)
insert into control.notification_channel (channel_name, channel_type, config)
values (
  'Default Email',
  'email',
  '{"recipients": ["admin@example.com"]}'::jsonb
)
on conflict (channel_name) do nothing;

-- ============================================================================
-- COMMENTS
-- ============================================================================

comment on table control.metric_baseline is 'Baseline profiling for adaptive alerting';
comment on table control.metric_baseline_query is 'Query-specific baseline profiling';
comment on table control.instance_settings is 'PostgreSQL instance capacity settings';
comment on table control.baseline_version is 'Baseline versioning and invalidation tracking';
comment on table control.instance_group is 'Instance grouping for alert scope management';
comment on table control.alert_snooze is 'Temporary alert suppression';
comment on table control.maintenance_window is 'Recurring maintenance windows';
comment on table control.notification_channel is 'Alert notification channels (email, slack, pagerduty, etc)';
