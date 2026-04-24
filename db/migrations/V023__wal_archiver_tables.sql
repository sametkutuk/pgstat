-- V023: WAL ve archiver snapshot tablolari
-- ============================================================================
-- PG10+ icin calisir (pg_current_wal_lsn, pg_ls_waldir, pg_stat_archiver
-- PG10'dan beri mevcut).

-- ----------------------------------------------------------------------------
-- WAL pozisyon ve disk snapshot'i
-- ----------------------------------------------------------------------------
-- Her cluster poll'unda bir satir: LSN, walfile, waldir boyutu, dosya sayisi.
-- period_wal_size_byte: onceki sample ile arasindaki LSN farki (delta)
create table if not exists fact.pg_wal_snapshot (
  sample_ts                timestamptz not null,
  instance_pk              bigint      not null,
  current_wal_lsn          text        null,       -- pg_lsn text olarak tutuluyor (serileştirme kolay)
  current_wal_file         text        null,
  wal_directory_size_byte  bigint      null,
  wal_file_count           integer     null,
  period_wal_size_byte     bigint      null,        -- onceki sample'dan bu sample'a LSN farki
  primary key (sample_ts, instance_pk)
) partition by range (sample_ts);

create index if not exists ix_pg_wal_snapshot_instance_ts
  on fact.pg_wal_snapshot (instance_pk, sample_ts desc);

-- ----------------------------------------------------------------------------
-- pg_stat_archiver snapshot'i
-- ----------------------------------------------------------------------------
-- WAL archiving durumu: archived_count, failed_count, last_archived/failed_wal
create table if not exists fact.pg_archiver_snapshot (
  sample_ts              timestamptz not null,
  instance_pk            bigint      not null,
  archived_count         bigint      null,
  last_archived_wal      text        null,
  last_archived_time     timestamptz null,
  failed_count           bigint      null,
  last_failed_wal        text        null,
  last_failed_time       timestamptz null,
  stats_reset            timestamptz null,
  primary key (sample_ts, instance_pk)
) partition by range (sample_ts);

create index if not exists ix_pg_archiver_snapshot_instance_ts
  on fact.pg_archiver_snapshot (instance_pk, sample_ts desc);

-- ----------------------------------------------------------------------------
-- Ilk partition'lari olustur (bugun + 14 gun ileri)
-- ----------------------------------------------------------------------------
do $$
declare
  d date;
  part_name text;
begin
  for d in select generate_series(current_date - interval '1 day',
                                   current_date + interval '14 days',
                                   interval '1 day')::date
  loop
    part_name := 'pg_wal_snapshot_' || to_char(d, 'YYYYMMDD');
    execute format(
      'create table if not exists fact.%I partition of fact.pg_wal_snapshot for values from (%L) to (%L)',
      part_name, d, d + 1
    );

    part_name := 'pg_archiver_snapshot_' || to_char(d, 'YYYYMMDD');
    execute format(
      'create table if not exists fact.%I partition of fact.pg_archiver_snapshot for values from (%L) to (%L)',
      part_name, d, d + 1
    );
  end loop;
end $$;

comment on table fact.pg_wal_snapshot     is 'WAL LSN, walfile ve waldir disk kullanimi snapshot''i (PG10+)';
comment on table fact.pg_archiver_snapshot is 'pg_stat_archiver snapshot''i — WAL archiving basari/hata sayaclari';
