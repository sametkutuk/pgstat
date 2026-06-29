-- V085: Per-query hourly WAL and latency rollup columns for Insights.

alter table agg.pgss_hourly
    add column if not exists wal_bytes_sum bigint,
    add column if not exists wal_records_sum bigint,
    add column if not exists wal_fpi_sum bigint,
    add column if not exists min_exec_time_ms double precision,
    add column if not exists avg_exec_time_ms double precision,
    add column if not exists max_exec_time_ms double precision;

comment on column agg.pgss_hourly.wal_bytes_sum is
    'sum(wal_bytes_delta) - per-query WAL trend icin saatlik rollup';

comment on column agg.pgss_hourly.wal_records_sum is
    'sum(wal_records_delta) - per-query WAL records trend icin saatlik rollup';

comment on column agg.pgss_hourly.wal_fpi_sum is
    'sum(wal_fpi_delta) - per-query WAL FPI trend icin saatlik rollup';

comment on column agg.pgss_hourly.min_exec_time_ms is
    'min(min_exec_time_ms) - saatlik minimum sorgu bazli latency trend';

comment on column agg.pgss_hourly.avg_exec_time_ms is
    'avg(mean_exec_time_ms) - saatlik ortalama sorgu bazli latency trend';

comment on column agg.pgss_hourly.max_exec_time_ms is
    'max(max_exec_time_ms) - saatlik maksimum sorgu bazli latency trend';
