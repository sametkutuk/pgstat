-- V088: ops.job_run / ops.job_run_instance icin started_at index'i
--
-- PurgeEvaluator.purgeJobRunHistory() "delete ... where started_at < now() -
-- interval" ile calisiyor ama ops.job_run'da started_at'i leading column
-- olarak kullanan bir index yoktu (mevcut ikisi de job_type/status ile
-- basliyor) — PostgreSQL bu WHERE kosulu icin sequential scan yapmak zorunda
-- kaliyordu. Musteri raporu (2026-08-19): gece purge'unda tek DELETE batch'i
-- 5-20 dakika suren "uzun suren sorgu" alertleri.
--
-- Canlida dogrulandi: ops.job_run 1.02M satir (225 MB), sadece 9503'u
-- (~%1) 30 gunden eski; ops.job_run_instance 2.24M satir (518 MB), hic
-- started_at-oncelikli index yok.
--
-- CREATE INDEX CONCURRENTLY bir transaction bloguna sarilamaz. Bu migration
-- dosyasi ./pgstat migrate tarafindan `psql -f` ile calistirilir (otomatik
-- transaction sarma yok), o yuzden CONCURRENTLY guvenle kullanilabilir.
-- Buyuk tablolarda CONCURRENTLY olmadan index olusturmak ACCESS EXCLUSIVE
-- lock alir ve production'da uzun bir kesintiye yol acar.

create index concurrently if not exists ix_job_run_started_at
  on ops.job_run (started_at);

create index concurrently if not exists ix_job_run_instance_started_at
  on ops.job_run_instance (started_at);

-- Ayni desen: PurgeEvaluator.purgeAlerts() "resolved_at < now() - interval"
-- ile calisiyor ama ops.alert'te resolved_at-oncelikli index yoktu. audit_log
-- (ix_audit_log_occurred_at) ve report_history (ix_report_history_at) icin
-- zaten var — sadece alert eksikti, onceden buyumedigi icin henuz alert
-- vermemis olabilir; onleyici olarak burada da ekleniyor.
create index concurrently if not exists ix_alert_resolved_at
  on ops.alert (resolved_at) where resolved_at is not null;
