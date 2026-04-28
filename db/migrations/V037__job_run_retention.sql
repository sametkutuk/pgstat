-- =============================================================================
-- V037: ops.job_run retention süresi config
-- Default 30 gün. Kullanıcı UI'dan (Ayarlar > Retention) değiştirebilir.
-- PurgeEvaluator.purgeJobRunHistory() bu değeri okur.
-- =============================================================================

alter table control.retention_policy
  add column if not exists job_run_retention_days integer not null default 30;

comment on column control.retention_policy.job_run_retention_days is
  'ops.job_run + ops.job_run_instance tablolari icin gun cinsinden retention. '
  'Default 30 gun. Gunde bir kez (UTC 02:00) eski kayitlar silinir.';
