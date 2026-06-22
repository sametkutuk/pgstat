-- =============================================================================
-- V083: Gece (nightly) snapshot tablolari icin retention
-- ============================================================================
-- SORUN: 4 nightly tablo PartitionManager ile her gun partition aliyor ama
-- PurgeEvaluator'in HICBIR listesinde yok -> sinirsiz buyuyor (ozellikle
-- fact.pg_relation_size_snapshot). retention_policy'nin hicbir alanina bagli
-- degillerdi.
--
-- TABLOLAR:
--   fact.pg_settings_snapshot         (PG parametreleri — gunde 1 set/instance)
--   fact.pg_relation_size_snapshot    (tablo/index boyutlari — gunde 1 set/DB)
--   fact.pg_sequence_state_snapshot   (sequence doluluk)
--   fact.pg_database_freeze_snapshot  (xid/mxid freeze yasi)
--
-- ANA MANTIK: Bu tablolar NightlySnapshotCollector ile gunde 1 kez (UTC 03:00)
-- toplaniyor -> zaten gunluk granularite (1 satir/gun). Bu yuzden saatlik/gunluk
-- ROLLUP (summarize) GEREKMEZ — diger snapshot'lar 60sn'de toplandigi icin rollup
-- sart, bunlar degil. Sadece gun-bazli retention ile purge edilirler.
-- 3 profilde de ayni mantik, sadece sure farkli (r3 kisa, r12 uzun).
-- =============================================================================

alter table control.retention_policy
  add column if not exists nightly_snapshot_retention_days integer;

-- Mevcut satirlara varsayilan ata (profil bazli). Bu tablolar yavas buyur
-- (gunde 1 satir) ama trend (boyut buyumesi, freeze yasi) icin makul sure tutulur.
update control.retention_policy
set nightly_snapshot_retention_days = 90
where policy_code = 'r3-short' and nightly_snapshot_retention_days is null;

update control.retention_policy
set nightly_snapshot_retention_days = 180
where policy_code = 'r6-default' and nightly_snapshot_retention_days is null;

update control.retention_policy
set nightly_snapshot_retention_days = 365
where policy_code = 'r12-long' and nightly_snapshot_retention_days is null;

-- Kalan/ozel profiller icin guvenli default (NULL kalmasin).
update control.retention_policy
set nightly_snapshot_retention_days = 180
where nightly_snapshot_retention_days is null;

alter table control.retention_policy
  alter column nightly_snapshot_retention_days set not null,
  alter column nightly_snapshot_retention_days set default 180;

alter table control.retention_policy
  drop constraint if exists ck_retention_policy_nightly_days;
alter table control.retention_policy
  add constraint ck_retention_policy_nightly_days
  check (nightly_snapshot_retention_days > 0);

comment on column control.retention_policy.nightly_snapshot_retention_days is
  'Gece (nightly) snapshot tablolari icin gun cinsinden retention: '
  'pg_settings_snapshot, pg_relation_size_snapshot, pg_sequence_state_snapshot, '
  'pg_database_freeze_snapshot. Gunde 1 kez toplandiklari icin rollup edilmez, '
  'sadece bu sureye gore purge edilir.';
