-- V061: WAL için daily rollup (3 ay+ retention)
-- 4 katmanlı yapı tamamlanır:
--   raw (24h) → hourly (90g) → daily (365g, yeni)

create table if not exists agg.pg_wal_daily (
    day_ts                   timestamptz not null,
    instance_pk              bigint      not null,
    sample_count             integer     not null,    -- günde kaç saat veri
    wal_bytes_total          bigint      null,
    wal_directory_size_avg   bigint      null,
    wal_file_count_avg       integer     null,
    primary key (day_ts, instance_pk)
);

create index if not exists ix_pg_wal_daily_instance_ts
    on agg.pg_wal_daily (instance_pk, day_ts desc);

alter table control.retention_policy
    add column if not exists daily_snapshot_retention_days smallint not null default 365;
