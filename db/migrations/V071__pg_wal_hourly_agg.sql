-- V071: Mevcut agg.pg_wal_hourly tablosuna pgss WAL metriklerini ekle.
--
-- Not: agg.pg_wal_hourly V055'te snapshot rollup icin zaten var
-- (hour_ts, wal_bytes_total). Bu migration tabloyu yeniden olusturmaz;
-- sadece WAL Spike grafikleri icin gerekli pgss kolonlarini ekler.

alter table agg.pg_wal_hourly
    add column if not exists wal_records_sum bigint,
    add column if not exists wal_fpi_sum bigint,
    add column if not exists calls_sum bigint;

comment on column agg.pg_wal_hourly.wal_records_sum is
    'pg_stat_statements wal_records_delta saatlik toplam.';

comment on column agg.pg_wal_hourly.wal_fpi_sum is
    'pg_stat_statements wal_fpi_delta saatlik toplam.';

comment on column agg.pg_wal_hourly.calls_sum is
    'pg_stat_statements calls_delta saatlik toplam.';
