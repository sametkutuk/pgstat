-- =============================================================================
-- V006: Operasyon tabloları
-- job_run, job_run_instance, alert
-- + index'ler
-- =============================================================================

-- Job çalıştırma kaydı: her scheduler döngüsünde bir satır
create table if not exists ops.job_run (
  job_run_id bigint generated always as identity primary key,
  job_type text not null,
  started_at timestamptz not null,
  finished_at timestamptz null,
  status text not null,
  worker_hostname text null,
  rows_written bigint not null default 0,
  instances_succeeded integer not null default 0,
  instances_failed integer not null default 0,
  error_text text null,
  constraint ck_job_run_status check (status in ('running', 'success', 'failed', 'partial')),
  constraint ck_job_run_rows_written check (rows_written >= 0),
  constraint ck_job_run_instances_succeeded check (instances_succeeded >= 0),
  constraint ck_job_run_instances_failed check (instances_failed >= 0)
);

-- Instance bazlı job sonucu: her instance için ayrı bir satır
create table if not exists ops.job_run_instance (
  job_run_instance_id bigint generated always as identity primary key,
  job_run_id bigint not null references ops.job_run(job_run_id) on delete cascade,
  instance_pk bigint not null,
  job_type text not null,
  started_at timestamptz not null,
  finished_at timestamptz null,
  status text not null,
  rows_written bigint not null default 0,
  new_series_count integer not null default 0,
  new_query_text_count integer not null default 0,
  error_text text null,
  constraint ck_job_run_instance_status check (status in ('running', 'success', 'failed', 'partial', 'skipped')),
  constraint ck_job_run_instance_rows_written check (rows_written >= 0),
  constraint ck_job_run_instance_new_series check (new_series_count >= 0),
  constraint ck_job_run_instance_new_query_text check (new_query_text_count >= 0)
);

-- Alert tablosu: collector tarafından üretilen uyarılar
create table if not exists ops.alert (
  alert_id bigint generated always as identity primary key,
  alert_key text not null,
  alert_code text not null,
  severity text not null,
  status text not null,
  source_component text not null,
  instance_pk bigint null,
  service_group text null,
  system_identifier bigint null,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  resolved_at timestamptz null,
  acknowledged_at timestamptz null,
  title text not null,
  message text not null,
  details_json jsonb null,
  occurrence_count integer not null default 1,
  constraint uq_alert_key unique (alert_key),
  constraint ck_alert_severity check (severity in ('info', 'warning', 'error', 'critical')),
  constraint ck_alert_status check (status in ('open', 'acknowledged', 'resolved')),
  constraint ck_alert_occurrence_count check (occurrence_count > 0)
);

-- Ops tabloları index'leri
create index if not exists ix_job_run_type_started
  on ops.job_run (job_type, started_at desc);

create index if not exists ix_job_run_status_started
  on ops.job_run (status, started_at desc);

create index if not exists ix_job_run_instance_pk_started
  on ops.job_run_instance (instance_pk, started_at desc);

create index if not exists ix_job_run_instance_job_status_started
  on ops.job_run_instance (job_type, status, started_at desc);

create index if not exists ix_alert_status_severity_last_seen
  on ops.alert (status, severity, last_seen_at desc);

create index if not exists ix_alert_instance_status_last_seen
  on ops.alert (instance_pk, status, last_seen_at desc);

create index if not exists ix_alert_service_group_status_last_seen
  on ops.alert (service_group, status, last_seen_at desc)
  where service_group is not null;
