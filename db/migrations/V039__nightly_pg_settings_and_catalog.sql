-- =============================================================================
-- V039: Gece çekilen PG parametre/catalog snapshot'lari
-- Alert'lerin "config doğru mu" kontrolleri için her gece 1 kere toplanir.
-- NightlySnapshotCollector UTC 03:00'te çalışır.
-- =============================================================================

-- pg_settings'in seçili anahtarları (memory, wal, autovacuum, jit)
create table if not exists fact.pg_settings_snapshot (
  snapshot_ts   timestamptz not null,
  instance_pk   bigint not null,
  setting_name  text not null,
  setting_value text not null,
  unit          text null,
  context       text null,
  source        text null,
  primary key (snapshot_ts, instance_pk, setting_name)
) partition by range (snapshot_ts);

create index if not exists ix_pg_settings_snapshot_inst
  on fact.pg_settings_snapshot (instance_pk, setting_name, snapshot_ts desc);

-- Tablo/index boyutları (heap + index + toast)
create table if not exists fact.pg_relation_size_snapshot (
  snapshot_ts        timestamptz not null,
  instance_pk        bigint not null,
  dbid               bigint not null,
  schemaname         text not null,
  relname            text not null,
  relkind            text not null,
  total_size_bytes   bigint null,
  table_size_bytes   bigint null,
  index_size_bytes   bigint null,
  toast_size_bytes   bigint null,
  primary key (snapshot_ts, instance_pk, dbid, schemaname, relname)
) partition by range (snapshot_ts);

create index if not exists ix_pg_relation_size_inst
  on fact.pg_relation_size_snapshot (instance_pk, total_size_bytes desc, snapshot_ts desc);

-- Sequence durumları (overflow uyarısı için)
create table if not exists fact.pg_sequence_state_snapshot (
  snapshot_ts    timestamptz not null,
  instance_pk    bigint not null,
  dbid           bigint not null,
  schemaname     text not null,
  seqname        text not null,
  data_type      text null,
  current_value  bigint null,
  max_value      bigint null,
  used_pct       numeric null,
  primary key (snapshot_ts, instance_pk, dbid, schemaname, seqname)
) partition by range (snapshot_ts);

-- DB seviyesi xid age (wraparound risk)
create table if not exists fact.pg_database_freeze_snapshot (
  snapshot_ts          timestamptz not null,
  instance_pk          bigint not null,
  dbid                 bigint not null,
  datname              text not null,
  datfrozenxid_age     bigint null,
  datminmxid_age       bigint null,
  primary key (snapshot_ts, instance_pk, dbid)
) partition by range (snapshot_ts);

-- Initial partition'lar (bugün + 14 gün)
do $$
declare
  d date;
  part_name text;
  tbl text;
begin
  foreach tbl in array array[
    'fact.pg_settings_snapshot',
    'fact.pg_relation_size_snapshot',
    'fact.pg_sequence_state_snapshot',
    'fact.pg_database_freeze_snapshot'
  ] loop
    for d in select generate_series(current_date - 1, current_date + 14, '1 day'::interval)::date loop
      part_name := replace(replace(tbl, 'fact.', ''), '.', '_') || '_' || to_char(d, 'YYYYMMDD');
      begin
        execute format(
          'create table if not exists fact.%I partition of %s for values from (%L) to (%L)',
          part_name, tbl,
          (d::text || ' 00:00:00+00')::timestamptz,
          ((d + 1)::text || ' 00:00:00+00')::timestamptz
        );
      exception when others then null;
      end;
    end loop;
  end loop;
end $$;
