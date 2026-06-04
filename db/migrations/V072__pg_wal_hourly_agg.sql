-- V072: Add pg_stat_statements WAL columns to existing agg.pg_wal_hourly.
-- The table already exists from V055 with hour_ts as primary time column.

alter table agg.pg_wal_hourly
    add column if not exists wal_bytes_sum bigint,
    add column if not exists wal_records_sum bigint,
    add column if not exists wal_fpi_sum bigint,
    add column if not exists calls_sum bigint;

comment on table agg.pg_wal_hourly is
    'WAL saatlik aggregate. V072 ile pgss WAL kolonlari (wal_bytes/records/fpi/calls) eklendi.';
