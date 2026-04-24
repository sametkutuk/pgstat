-- V024: pg_replication_slots + pg_stat_database_conflicts snapshot tablolari
-- ============================================================================
-- Replikasyon slot'larinin saglik durumu ve standby conflict'larini takip etmek.

-- ----------------------------------------------------------------------------
-- Replication slot snapshot'i (per slot)
-- ----------------------------------------------------------------------------
create table if not exists fact.pg_replication_slot_snapshot (
  sample_ts        timestamptz not null,
  instance_pk      bigint      not null,
  slot_name        text        not null,
  plugin           text        null,
  slot_type        text        null,     -- physical | logical
  database         text        null,
  active           boolean     null,
  active_pid       integer     null,
  xmin_int         bigint      null,
  catalog_xmin_int bigint      null,
  restart_lsn      text        null,
  confirmed_flush_lsn text     null,
  wal_status       text        null,     -- PG13+: reserved | extended | unreserved | lost
  safe_wal_size    bigint      null,     -- PG13+
  slot_lag_bytes   bigint      null,     -- current_wal_lsn - restart_lsn
  -- Yalnizca PG14+ pg_stat_replication_slots
  spill_txns       bigint      null,
  spill_count      bigint      null,
  spill_bytes      bigint      null,
  stream_txns      bigint      null,
  stream_count     bigint      null,
  stream_bytes     bigint      null,
  total_txns       bigint      null,
  total_bytes      bigint      null,
  primary key (sample_ts, instance_pk, slot_name)
) partition by range (sample_ts);

create index if not exists ix_pg_slot_snapshot_instance_ts
  on fact.pg_replication_slot_snapshot (instance_pk, sample_ts desc);

-- ----------------------------------------------------------------------------
-- Database conflicts snapshot'i (standby conflict'lari)
-- ----------------------------------------------------------------------------
create table if not exists fact.pg_database_conflict_snapshot (
  sample_ts          timestamptz not null,
  instance_pk        bigint      not null,
  datname            text        not null,
  confl_tablespace   bigint      null,
  confl_lock         bigint      null,
  confl_snapshot     bigint      null,
  confl_bufferpin    bigint      null,
  confl_deadlock     bigint      null,
  primary key (sample_ts, instance_pk, datname)
) partition by range (sample_ts);

create index if not exists ix_pg_conflict_snapshot_instance_ts
  on fact.pg_database_conflict_snapshot (instance_pk, sample_ts desc);

-- ----------------------------------------------------------------------------
-- Ilk partition'lar
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
    part_name := 'pg_replication_slot_snapshot_' || to_char(d, 'YYYYMMDD');
    execute format(
      'create table if not exists fact.%I partition of fact.pg_replication_slot_snapshot for values from (%L) to (%L)',
      part_name, d, d + 1
    );

    part_name := 'pg_database_conflict_snapshot_' || to_char(d, 'YYYYMMDD');
    execute format(
      'create table if not exists fact.%I partition of fact.pg_database_conflict_snapshot for values from (%L) to (%L)',
      part_name, d, d + 1
    );
  end loop;
end $$;

comment on table fact.pg_replication_slot_snapshot
  is 'pg_replication_slots + pg_stat_replication_slots (PG14+) snapshot';
comment on table fact.pg_database_conflict_snapshot
  is 'pg_stat_database_conflicts snapshot — standby recovery conflict sayaclari';
