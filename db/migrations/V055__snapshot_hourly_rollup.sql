-- V055: Snapshot tabloları için hourly rollup
-- 3 katmanlı veri yaşam döngüsü:
--   raw (60s sample) → 24h sonra → hourly rollup (1 satır/saat) → 90g sonra → daily rollup
-- Disk %95 azalır. Health Report ve uzun-vade grafiklerde hourly'den okunur.

create table if not exists agg.pg_wal_hourly (
    hour_ts                  timestamptz not null,
    instance_pk              bigint      not null,
    sample_count             integer     not null,
    wal_bytes_total          bigint      null,     -- saat içindeki toplam üretim
    wal_directory_size_avg   bigint      null,     -- saat içindeki ortalama disk
    wal_file_count_avg       integer     null,
    primary key (hour_ts, instance_pk)
);

create index if not exists ix_pg_wal_hourly_instance_ts
    on agg.pg_wal_hourly (instance_pk, hour_ts desc);

create table if not exists agg.pg_archiver_hourly (
    hour_ts             timestamptz not null,
    instance_pk         bigint      not null,
    sample_count        integer     not null,
    archived_count_max  bigint      null,
    failed_count_max    bigint      null,
    last_archived_wal   text        null,
    last_failed_wal     text        null,
    primary key (hour_ts, instance_pk)
);

create index if not exists ix_pg_archiver_hourly_instance_ts
    on agg.pg_archiver_hourly (instance_pk, hour_ts desc);

-- Snapshot retention raw için 24h yeterli (hourly varsa)
update control.retention_policy
   set snapshot_retention_hours = 24
 where policy_code in ('r3-short', 'r6-default', 'r12-long');

alter table control.retention_policy
    alter column snapshot_retention_hours set default 24;

-- Hourly rollup retention için yeni kolon (gün bazlı)
alter table control.retention_policy
    add column if not exists hourly_snapshot_retention_days smallint not null default 90;
