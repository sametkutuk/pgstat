-- =============================================================================
-- V042: Sistem alert konfigürasyonu
-- Her alert kodu için global default + instance bazlı override.
-- UI'dan toggle, eşik ve cooldown ayarlanabilir.
-- Collector SystemAlertConfigCache ile 60s'de bir okur.
-- =============================================================================

create table if not exists control.system_alert_config (
  config_id        serial primary key,
  alert_code       text not null,
  instance_pk      bigint null,             -- null = global default, değer = instance override
  is_enabled       boolean not null default true,
  threshold_value  numeric null,            -- alert tipine özel eşik (null = eşik yok/default)
  cooldown_minutes integer not null default 60,
  updated_at       timestamptz not null default now(),
  updated_by       text null
);

-- NULL-safe unique constraint'ler (PG'de NULL != NULL unique'te)
create unique index if not exists uq_system_alert_config_global
  on control.system_alert_config (alert_code) where instance_pk is null;
create unique index if not exists uq_system_alert_config_instance
  on control.system_alert_config (alert_code, instance_pk) where instance_pk is not null;

-- Seed: tüm sistem alert kodları için global default
insert into control.system_alert_config (alert_code, is_enabled, threshold_value, cooldown_minutes) values
  ('connection_failure',         true,  null,    5),
  ('authentication_failure',     true,  null,    5),
  ('permission_denied',          true,  null,    30),
  ('extension_missing',          true,  null,    60),
  ('secret_ref_error',           true,  null,    5),
  ('bootstrap_failed',           true,  null,    30),
  ('stale_data',                 true,  null,    60),
  ('stats_reset_detected',       true,  null,    60),
  ('lock_contention',            true,  null,    15),
  ('high_connection_usage',      true,  80,      15),
  ('long_running_query',         true,  300,     30),
  ('replication_lag',            true,  50,      15),
  ('high_bloat_ratio',           true,  20,      1440),
  ('index_suspect_missing',      true,  100,     1440),
  ('index_unused',               true,  100,     1440),
  ('high_temp_files',            true,  100,     60),
  ('idle_in_tx_time_high',       true,  30,      60),
  ('replication_slot_inactive',  true,  1024,    60),
  ('job_partial_failure',        true,  null,    60),
  ('job_failed',                 true,  null,    30),
  ('advisory_lock_skip',         true,  null,    60)
on conflict do nothing;
