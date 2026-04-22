-- =============================================================================
-- V008: Varsayılan seed veriler
-- Zamanlama profili ve retention politikaları
-- =============================================================================

-- Varsayılan zamanlama profili
insert into control.schedule_profile (
  profile_code,
  cluster_interval_seconds,
  statements_interval_seconds,
  db_objects_interval_seconds,
  hourly_rollup_interval_seconds,
  daily_rollup_hour_utc,
  bootstrap_sql_text_batch,
  max_databases_per_run,
  statement_timeout_ms,
  lock_timeout_ms,
  connect_timeout_seconds,
  max_host_concurrency
) values (
  'default', 60, 300, 1800, 3600, 1, 100, 5, 5000, 250, 5, 1
) on conflict (profile_code) do nothing;

-- Yüksek frekanslı toplama profili (kritik instance'lar için)
insert into control.schedule_profile (
  profile_code,
  cluster_interval_seconds,
  statements_interval_seconds,
  db_objects_interval_seconds,
  hourly_rollup_interval_seconds,
  daily_rollup_hour_utc,
  bootstrap_sql_text_batch,
  max_databases_per_run,
  statement_timeout_ms,
  lock_timeout_ms,
  connect_timeout_seconds,
  max_host_concurrency
) values (
  'high-frequency', 30, 120, 900, 3600, 1, 200, 10, 5000, 250, 5, 2
) on conflict (profile_code) do nothing;

-- Retention politikaları: 3, 6 ve 12 aylık
insert into control.retention_policy (policy_code, raw_retention_months, hourly_retention_months, daily_retention_months)
values ('r3-short',  3,  3,  12) on conflict (policy_code) do nothing;

insert into control.retention_policy (policy_code, raw_retention_months, hourly_retention_months, daily_retention_months)
values ('r6-default', 6,  6,  24) on conflict (policy_code) do nothing;

insert into control.retention_policy (policy_code, raw_retention_months, hourly_retention_months, daily_retention_months)
values ('r12-long',  12, 12, 36) on conflict (policy_code) do nothing;
