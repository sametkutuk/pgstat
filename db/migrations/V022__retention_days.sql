-- V022: Retention'i day-bazli yap + activity/lock/progress icin ayri kisa retention
-- ============================================================================
-- Sorun: raw_retention_months 3 ay = cok uzun. pg_activity_snapshot gibi
-- hizli buyuyen tablolar icin farkli retention gerekli.

-- ----------------------------------------------------------------------------
-- 1) Day-bazli kolonlar ekle (eski _months kolonlari uyumluluk icin kalsin)
-- ----------------------------------------------------------------------------
alter table control.retention_policy
  add column if not exists raw_retention_days    integer,
  add column if not exists hourly_retention_days integer,
  add column if not exists daily_retention_days  integer,
  -- Activity/lock/progress gibi yuksek hacimli snapshot'lar icin ayri retention
  add column if not exists snapshot_retention_hours integer;

-- Eski _months degerlerini _days'e cevir (migration ilk calistigi anda)
update control.retention_policy
set
  raw_retention_days    = coalesce(raw_retention_days,    raw_retention_months * 30),
  hourly_retention_days = coalesce(hourly_retention_days, hourly_retention_months * 30),
  daily_retention_days  = coalesce(daily_retention_days,  daily_retention_months * 30),
  snapshot_retention_hours = coalesce(snapshot_retention_hours, 48)
where raw_retention_days is null
   or hourly_retention_days is null
   or daily_retention_days is null
   or snapshot_retention_hours is null;

-- Artik zorunlu
alter table control.retention_policy
  alter column raw_retention_days    set not null,
  alter column hourly_retention_days set not null,
  alter column daily_retention_days  set not null,
  alter column snapshot_retention_hours set not null;

alter table control.retention_policy
  alter column raw_retention_days       set default 14,
  alter column hourly_retention_days    set default 30,
  alter column daily_retention_days     set default 365,
  alter column snapshot_retention_hours set default 48;

-- Check constraint'ler
alter table control.retention_policy
  drop constraint if exists ck_retention_policy_raw_days,
  drop constraint if exists ck_retention_policy_hourly_days,
  drop constraint if exists ck_retention_policy_daily_days,
  drop constraint if exists ck_retention_policy_snapshot_hours;
alter table control.retention_policy
  add constraint ck_retention_policy_raw_days       check (raw_retention_days > 0),
  add constraint ck_retention_policy_hourly_days    check (hourly_retention_days > 0),
  add constraint ck_retention_policy_daily_days     check (daily_retention_days > 0),
  add constraint ck_retention_policy_snapshot_hours check (snapshot_retention_hours > 0);

-- ----------------------------------------------------------------------------
-- 2) Mevcut policy default'larini agresif degerlere duzelt
-- ----------------------------------------------------------------------------
-- r3-short: raw=3ay=90gun -> 7gun (sistem yeni, diske aldanmayalim)
update control.retention_policy
set raw_retention_days = 7,
    hourly_retention_days = 30,
    daily_retention_days = 365,
    snapshot_retention_hours = 24
where policy_code = 'r3-short';

-- r6-default: raw=14gun, hourly=60gun, daily=2yil, snapshot=48 saat
update control.retention_policy
set raw_retention_days = 14,
    hourly_retention_days = 60,
    daily_retention_days = 730,
    snapshot_retention_hours = 48
where policy_code = 'r6-default';

-- r12-long: raw=30gun, hourly=180gun, daily=3yil, snapshot=72 saat
update control.retention_policy
set raw_retention_days = 30,
    hourly_retention_days = 180,
    daily_retention_days = 1095,
    snapshot_retention_hours = 72
where policy_code = 'r12-long';

comment on column control.retention_policy.raw_retention_days       is 'Ham delta tablolari (pgss_delta, pg_cluster_delta, pg_database_delta, pg_*_stat_delta) icin gun cinsinden retention';
comment on column control.retention_policy.hourly_retention_days    is 'agg.pgss_hourly icin gun cinsinden retention';
comment on column control.retention_policy.daily_retention_days     is 'agg.pgss_daily icin gun cinsinden retention';
comment on column control.retention_policy.snapshot_retention_hours is 'pg_activity_snapshot, pg_lock_snapshot, pg_progress_snapshot, pg_replication_snapshot icin saat cinsinden retention (hizli buyur)';
