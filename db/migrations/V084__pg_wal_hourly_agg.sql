-- V084: Ensure pgss WAL hourly aggregate support for Insights WAL trend.

create schema if not exists agg;

create table if not exists agg.pg_wal_hourly (
    hour_ts timestamptz not null,
    instance_pk bigint not null,
    sample_count integer not null,
    wal_bytes_total bigint,
    wal_directory_size_avg bigint,
    wal_file_count_avg integer,
    wal_bytes_sum bigint,
    wal_records_sum bigint,
    wal_fpi_sum bigint,
    calls_sum bigint,
    primary key (hour_ts, instance_pk)
);

alter table agg.pg_wal_hourly
    add column if not exists wal_bytes_sum bigint,
    add column if not exists wal_records_sum bigint,
    add column if not exists wal_fpi_sum bigint,
    add column if not exists calls_sum bigint;

create index if not exists ix_pg_wal_hourly_bucket
    on agg.pg_wal_hourly (hour_ts desc);

create index if not exists ix_pg_wal_hourly_instance_bucket
    on agg.pg_wal_hourly (instance_pk, hour_ts desc);

comment on table agg.pg_wal_hourly is
    'WAL hourly aggregate. Snapshot WAL columns plus pg_stat_statements WAL rollup columns for /wal-trend long ranges.';
