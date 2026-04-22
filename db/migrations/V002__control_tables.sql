-- =============================================================================
-- V002: Control şeması tabloları
-- schedule_profile, retention_policy, instance_inventory,
-- instance_capability, instance_state, database_state
-- + trigger'lar ve index'ler
-- =============================================================================

-- Zamanlama profili: her job tipi için toplama aralıkları
create table if not exists control.schedule_profile (
  schedule_profile_id bigint generated always as identity primary key,
  profile_code text not null,
  cluster_interval_seconds integer not null default 60,
  statements_interval_seconds integer not null default 300,
  db_objects_interval_seconds integer not null default 1800,
  hourly_rollup_interval_seconds integer not null default 3600,
  daily_rollup_hour_utc integer not null default 1,
  bootstrap_sql_text_batch integer not null default 100,
  max_databases_per_run integer not null default 5,
  statement_timeout_ms integer not null default 5000,
  lock_timeout_ms integer not null default 250,
  connect_timeout_seconds integer not null default 5,
  max_host_concurrency integer not null default 1,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_schedule_profile_code unique (profile_code),
  constraint ck_schedule_profile_cluster_interval check (cluster_interval_seconds > 0),
  constraint ck_schedule_profile_statements_interval check (statements_interval_seconds > 0),
  constraint ck_schedule_profile_db_objects_interval check (db_objects_interval_seconds > 0),
  constraint ck_schedule_profile_rollup_interval check (hourly_rollup_interval_seconds > 0),
  constraint ck_schedule_profile_daily_rollup_hour check (daily_rollup_hour_utc between 0 and 23),
  constraint ck_schedule_profile_bootstrap_batch check (bootstrap_sql_text_batch > 0),
  constraint ck_schedule_profile_max_databases_per_run check (max_databases_per_run > 0),
  constraint ck_schedule_profile_statement_timeout check (statement_timeout_ms > 0),
  constraint ck_schedule_profile_lock_timeout check (lock_timeout_ms >= 0),
  constraint ck_schedule_profile_connect_timeout check (connect_timeout_seconds > 0),
  constraint ck_schedule_profile_host_concurrency check (max_host_concurrency > 0)
);

-- Veri saklama politikası: ham, saatlik ve günlük retention süreleri
create table if not exists control.retention_policy (
  retention_policy_id bigint generated always as identity primary key,
  policy_code text not null,
  raw_retention_months integer not null,
  hourly_retention_months integer not null,
  daily_retention_months integer not null,
  is_active boolean not null default true,
  purge_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_retention_policy_code unique (policy_code),
  constraint ck_retention_policy_raw_months check (raw_retention_months > 0),
  constraint ck_retention_policy_hourly_months check (hourly_retention_months > 0),
  constraint ck_retention_policy_daily_months check (daily_retention_months > 0)
);

-- Ana envanter tablosu: izlenen her PostgreSQL instance
create table if not exists control.instance_inventory (
  instance_pk bigint generated always as identity primary key,
  instance_id text not null,
  display_name text not null,
  environment text null,
  service_group text null,
  host text not null,
  port integer not null default 5432,
  admin_dbname text not null default 'postgres',
  secret_ref text not null,
  ssl_mode text not null default 'prefer',
  ssl_root_cert_path text null,
  schedule_profile_id bigint not null references control.schedule_profile(schedule_profile_id),
  retention_policy_id bigint not null references control.retention_policy(retention_policy_id),
  is_active boolean not null default true,
  bootstrap_state text not null default 'pending',
  collector_group text null,
  notes text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_instance_inventory_instance_id unique (instance_id),
  constraint uq_instance_inventory_host_port_db unique (host, port, admin_dbname),
  constraint ck_instance_inventory_port check (port between 1 and 65535),
  constraint ck_instance_inventory_ssl_mode check (
    ssl_mode in ('disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full')
  ),
  constraint ck_instance_inventory_bootstrap_state check (
    bootstrap_state in ('pending', 'discovering', 'baselining', 'enriching', 'ready', 'degraded', 'paused')
  )
);

-- Instance yetenek bilgileri: versiyon, özellik bayrakları
create table if not exists control.instance_capability (
  instance_pk bigint primary key references control.instance_inventory(instance_pk) on delete cascade,
  server_version_num integer null,
  pg_major integer null,
  system_identifier bigint null,
  is_reachable boolean null,
  is_primary boolean null,
  has_pg_stat_statements boolean not null default false,
  has_pg_stat_statements_info boolean not null default false,
  has_pg_stat_io boolean not null default false,
  has_pg_stat_checkpointer boolean not null default false,
  compute_query_id_mode text null,
  collector_sql_family text null,
  last_postmaster_start_at timestamptz null,
  last_pgss_stats_reset_at timestamptz null,
  last_discovered_at timestamptz null,
  last_error_at timestamptz null,
  last_error_text text null,
  constraint ck_instance_capability_version check (server_version_num is null or server_version_num > 0),
  constraint ck_instance_capability_pg_major check (pg_major is null or pg_major > 0),
  constraint ck_instance_capability_system_identifier check (system_identifier is null or system_identifier > 0),
  constraint ck_instance_capability_query_id_mode check (
    compute_query_id_mode is null or compute_query_id_mode in ('off', 'on', 'auto', 'regress', 'external')
  )
);

-- Instance toplama durumu: son/sonraki toplama zamanları, backoff
create table if not exists control.instance_state (
  instance_pk bigint primary key references control.instance_inventory(instance_pk) on delete cascade,
  last_cluster_collect_at timestamptz null,
  last_statements_collect_at timestamptz null,
  last_rollup_at timestamptz null,
  next_cluster_collect_at timestamptz null,
  next_statements_collect_at timestamptz null,
  bootstrap_completed_at timestamptz null,
  current_pgss_epoch_key text null,
  last_cluster_stats_reset_at timestamptz null,
  consecutive_failures integer not null default 0,
  backoff_until timestamptz null,
  last_success_at timestamptz null,
  constraint ck_instance_state_consecutive_failures check (consecutive_failures >= 0)
);

-- Database bazlı toplama durumu: db_objects job için
create table if not exists control.database_state (
  instance_pk bigint not null references control.instance_inventory(instance_pk) on delete cascade,
  dbid oid not null,
  last_db_objects_collect_at timestamptz null,
  next_db_objects_collect_at timestamptz null,
  consecutive_failures integer not null default 0,
  backoff_until timestamptz null,
  last_error_at timestamptz null,
  last_error_text text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (instance_pk, dbid),
  constraint ck_database_state_consecutive_failures check (consecutive_failures >= 0)
);

-- updated_at trigger'ları
create trigger trg_schedule_profile_updated_at
before update on control.schedule_profile
for each row execute function control.set_updated_at();

create trigger trg_retention_policy_updated_at
before update on control.retention_policy
for each row execute function control.set_updated_at();

create trigger trg_instance_inventory_updated_at
before update on control.instance_inventory
for each row execute function control.set_updated_at();

create trigger trg_database_state_updated_at
before update on control.database_state
for each row execute function control.set_updated_at();

-- Control tabloları index'leri
create index if not exists ix_instance_inventory_schedule_profile
  on control.instance_inventory (schedule_profile_id);

create index if not exists ix_instance_inventory_retention_policy
  on control.instance_inventory (retention_policy_id);

create index if not exists ix_instance_inventory_service_group
  on control.instance_inventory (service_group, instance_id);

create index if not exists ix_retention_policy_active
  on control.retention_policy (is_active, policy_code)
  where is_active;

create index if not exists ix_instance_inventory_active_group
  on control.instance_inventory (collector_group, instance_id)
  where is_active;

create index if not exists ix_instance_inventory_active_bootstrap
  on control.instance_inventory (bootstrap_state, instance_id)
  where is_active;

create index if not exists ix_instance_capability_unreachable
  on control.instance_capability (last_discovered_at)
  where is_reachable = false or is_reachable is null;

create index if not exists ix_instance_state_next_cluster
  on control.instance_state (next_cluster_collect_at)
  where next_cluster_collect_at is not null;

create index if not exists ix_instance_state_next_statements
  on control.instance_state (next_statements_collect_at)
  where next_statements_collect_at is not null;

create index if not exists ix_instance_state_backoff
  on control.instance_state (backoff_until)
  where backoff_until is not null;

create index if not exists ix_instance_state_last_success
  on control.instance_state (last_success_at);

create index if not exists ix_database_state_next_db_objects
  on control.database_state (next_db_objects_collect_at)
  where next_db_objects_collect_at is not null;

create index if not exists ix_database_state_backoff
  on control.database_state (backoff_until)
  where backoff_until is not null;
