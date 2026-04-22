-- =============================================================================
-- V005: Aggregation tabloları
-- pgss_hourly (saatlik rollup), pgss_daily (günlük rollup)
-- + index'ler
-- =============================================================================

-- Saatlik rollup: pgss_delta verilerinin saatlik toplamı
create table if not exists agg.pgss_hourly (
  bucket_start timestamptz not null,
  instance_pk bigint not null,
  statement_series_id bigint not null,
  calls_sum bigint not null,
  exec_time_ms_sum double precision not null,
  rows_sum bigint null,
  shared_blks_read_sum bigint null,
  shared_blks_hit_sum bigint null,
  temp_blks_written_sum bigint null,
  primary key (bucket_start, instance_pk, statement_series_id)
) partition by range (bucket_start);

-- Günlük rollup: saatlik verilerin günlük toplamı
create table if not exists agg.pgss_daily (
  bucket_start date not null,
  instance_pk bigint not null,
  statement_series_id bigint not null,
  calls_sum bigint not null,
  exec_time_ms_sum double precision not null,
  rows_sum bigint null,
  shared_blks_read_sum bigint null,
  shared_blks_hit_sum bigint null,
  temp_blks_written_sum bigint null,
  primary key (bucket_start, instance_pk, statement_series_id)
) partition by range (bucket_start);

-- Agg tabloları index'leri
create index if not exists ix_pgss_hourly_instance_series_bucket
  on agg.pgss_hourly (instance_pk, statement_series_id, bucket_start desc);

create index if not exists ix_pgss_hourly_bucket
  on agg.pgss_hourly (bucket_start desc);

create index if not exists ix_pgss_daily_instance_series_bucket
  on agg.pgss_daily (instance_pk, statement_series_id, bucket_start desc);

create index if not exists ix_pgss_daily_bucket
  on agg.pgss_daily (bucket_start desc);
