-- V067: Phase 2 — eksik stat view kolonlari ve yeni tablolar.
-- Kaynak: docs/pg-stat-views-matrix.md + docs/collector-audit.md

-- =========================================================================
-- MADDE 2: fact.pg_replication_slot_snapshot — PG17+ slot health kolonlari
-- =========================================================================
alter table fact.pg_replication_slot_snapshot
  add column if not exists temporary            boolean null,
  add column if not exists two_phase            boolean null,
  add column if not exists conflicting          boolean null,
  add column if not exists invalidation_reason  text null,
  add column if not exists failover             boolean null,
  add column if not exists synced               boolean null;

comment on column fact.pg_replication_slot_snapshot.temporary is 'Gecici slot mu (PG10+)';
comment on column fact.pg_replication_slot_snapshot.two_phase is '2PC destegi (PG15+)';
comment on column fact.pg_replication_slot_snapshot.conflicting is 'Conflict durumunda mi (PG17+)';
comment on column fact.pg_replication_slot_snapshot.invalidation_reason is 'Gecersizlesme nedeni (PG17+)';
comment on column fact.pg_replication_slot_snapshot.failover is 'Failover slot mu (PG17+)';
comment on column fact.pg_replication_slot_snapshot.synced is 'Senkronize edilmis mi (PG17+)';

-- =========================================================================
-- MADDE 3: fact.pg_wal_receiver_snapshot — tamamen yeni tablo
-- =========================================================================
create table if not exists fact.pg_wal_receiver_snapshot (
  sample_ts              timestamptz not null,
  instance_pk            bigint not null,
  pid                    integer,
  status                 text,
  receive_start_lsn      text,
  receive_start_tli      integer,
  written_lsn            text,
  flushed_lsn            text,
  received_tli           integer,
  last_msg_send_time     timestamptz,
  last_msg_receipt_time  timestamptz,
  latest_end_lsn         text,
  latest_end_time        timestamptz,
  slot_name              text,
  sender_host            text,
  sender_port            integer,
  lag_bytes              bigint
) partition by range (sample_ts);

comment on table fact.pg_wal_receiver_snapshot is 'pg_stat_wal_receiver snapshot (standby only, PG9.6+)';

-- =========================================================================
-- MADDE 4: fact.pg_table_stat_delta — PG18 vacuum/analyze time kolonlari
-- =========================================================================
alter table fact.pg_table_stat_delta
  add column if not exists total_vacuum_time_ms_delta       double precision null,
  add column if not exists total_autovacuum_time_ms_delta   double precision null,
  add column if not exists total_analyze_time_ms_delta      double precision null,
  add column if not exists total_autoanalyze_time_ms_delta  double precision null;

comment on column fact.pg_table_stat_delta.total_vacuum_time_ms_delta is 'Manuel vacuum toplam sure delta ms (PG18+)';
comment on column fact.pg_table_stat_delta.total_autovacuum_time_ms_delta is 'Autovacuum toplam sure delta ms (PG18+)';
comment on column fact.pg_table_stat_delta.total_analyze_time_ms_delta is 'Manuel analyze toplam sure delta ms (PG18+)';
comment on column fact.pg_table_stat_delta.total_autoanalyze_time_ms_delta is 'Autoanalyze toplam sure delta ms (PG18+)';

-- =========================================================================
-- MADDE 5: fact.pg_subscription_snapshot — PG18 worker_type
-- =========================================================================
alter table fact.pg_subscription_snapshot
  add column if not exists worker_type text null;

comment on column fact.pg_subscription_snapshot.worker_type is 'Worker tipi: apply/parallel apply/table synchronization (PG18+)';

-- =========================================================================
-- MADDE 6: fact.pg_subscription_snapshot — PG18 7 conflict kolonlari
-- =========================================================================
alter table fact.pg_subscription_snapshot
  add column if not exists confl_insert_exists_delta              bigint null,
  add column if not exists confl_update_origin_differs_delta      bigint null,
  add column if not exists confl_update_exists_delta              bigint null,
  add column if not exists confl_update_missing_delta             bigint null,
  add column if not exists confl_delete_origin_differs_delta      bigint null,
  add column if not exists confl_delete_missing_delta             bigint null,
  add column if not exists confl_multiple_unique_conflicts_delta  bigint null;

-- =========================================================================
-- MADDE 8: fact.pg_progress_vacuum_snapshot — vacuum-specific full kolonlar
-- =========================================================================
create table if not exists fact.pg_progress_vacuum_snapshot (
  sample_ts              timestamptz not null,
  instance_pk            bigint not null,
  pid                    integer,
  datid                  bigint,
  datname                text,
  relid                  bigint,
  phase                  text,
  heap_blks_total        bigint,
  heap_blks_scanned      bigint,
  heap_blks_vacuumed     bigint,
  index_vacuum_count     bigint,
  max_dead_item_ids      bigint,
  max_dead_tuple_bytes   bigint,
  num_dead_item_ids      bigint,
  dead_tuple_bytes       bigint,
  indexes_total          bigint,
  indexes_processed      bigint
) partition by range (sample_ts);

-- =========================================================================
-- MADDE 9: fact.pg_progress_analyze_snapshot
-- =========================================================================
create table if not exists fact.pg_progress_analyze_snapshot (
  sample_ts              timestamptz not null,
  instance_pk            bigint not null,
  pid                    integer,
  datid                  bigint,
  datname                text,
  relid                  bigint,
  phase                  text,
  sample_blks_total      bigint,
  sample_blks_scanned    bigint,
  ext_stats_total        bigint,
  ext_stats_computed     bigint,
  child_tables_total     bigint,
  child_tables_done      bigint,
  current_child_table_relid bigint
) partition by range (sample_ts);

-- =========================================================================
-- MADDE 10: fact.pg_progress_create_index_snapshot
-- =========================================================================
create table if not exists fact.pg_progress_create_index_snapshot (
  sample_ts              timestamptz not null,
  instance_pk            bigint not null,
  pid                    integer,
  datid                  bigint,
  datname                text,
  relid                  bigint,
  index_relid            bigint,
  command                text,
  phase                  text,
  lockers_total          bigint,
  lockers_done           bigint,
  current_locker_pid     bigint,
  blocks_total           bigint,
  blocks_done            bigint,
  tuples_total           bigint,
  tuples_done            bigint,
  partitions_total       bigint,
  partitions_done        bigint
) partition by range (sample_ts);

-- =========================================================================
-- MADDE 11: fact.pg_progress_basebackup_snapshot (PG13+)
-- =========================================================================
create table if not exists fact.pg_progress_basebackup_snapshot (
  sample_ts              timestamptz not null,
  instance_pk            bigint not null,
  pid                    integer,
  phase                  text,
  backup_total           bigint,
  backup_streamed        bigint,
  tablespaces_total      bigint,
  tablespaces_streamed   bigint
) partition by range (sample_ts);

-- =========================================================================
-- MADDE 12: fact.pg_progress_copy_snapshot (PG14+)
-- =========================================================================
create table if not exists fact.pg_progress_copy_snapshot (
  sample_ts              timestamptz not null,
  instance_pk            bigint not null,
  pid                    integer,
  datid                  bigint,
  datname                text,
  relid                  bigint,
  command                text,
  copy_type              text,
  bytes_processed        bigint,
  bytes_total            bigint,
  tuples_processed       bigint,
  tuples_excluded        bigint,
  tuples_skipped         bigint
) partition by range (sample_ts);

-- =========================================================================
-- MADDE 13: fact.pg_progress_cluster_snapshot (PG12+)
-- =========================================================================
create table if not exists fact.pg_progress_cluster_snapshot (
  sample_ts              timestamptz not null,
  instance_pk            bigint not null,
  pid                    integer,
  datid                  bigint,
  datname                text,
  relid                  bigint,
  command                text,
  phase                  text,
  cluster_index_relid    bigint,
  heap_tuples_scanned    bigint,
  heap_tuples_written    bigint,
  heap_blks_total        bigint,
  heap_blks_scanned      bigint,
  index_rebuild_count    bigint
) partition by range (sample_ts);

-- =========================================================================
-- Partition olusturma (30 gunluk, diger tablolarla ayni pattern)
-- =========================================================================
do $$
declare
  d date;
  part_name text;
  tbl text;
  tables text[] := array[
    'pg_wal_receiver_snapshot',
    'pg_progress_vacuum_snapshot',
    'pg_progress_analyze_snapshot',
    'pg_progress_create_index_snapshot',
    'pg_progress_basebackup_snapshot',
    'pg_progress_copy_snapshot',
    'pg_progress_cluster_snapshot'
  ];
begin
  for d in select generate_series(current_date, current_date + 30, '1 day'::interval)::date loop
    foreach tbl in array tables loop
      part_name := tbl || '_' || to_char(d, 'YYYYMMDD');
      execute format(
        'create table if not exists fact.%I partition of fact.%I for values from (%L) to (%L)',
        part_name, tbl, d, d + 1
      );
    end loop;
  end loop;
end $$;
