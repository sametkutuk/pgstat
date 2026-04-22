-- =============================================================================
-- V004: Fact tabloları (partitioned parent tables)
-- 10 tablo: pgss_delta, pg_database_delta, pg_table_stat_delta,
-- pg_index_stat_delta, pg_cluster_delta, pg_io_stat_delta,
-- pg_activity_snapshot, pg_lock_snapshot, pg_progress_snapshot,
-- pg_replication_snapshot
-- + index'ler
-- =============================================================================

-- pg_stat_statements delta: her toplama döngüsündeki fark değerler
create table if not exists fact.pgss_delta (
  sample_ts timestamptz not null,
  instance_pk bigint not null,
  statement_series_id bigint not null references dim.statement_series(statement_series_id),
  calls_delta bigint not null,
  plans_delta bigint null,
  total_plan_time_ms_delta double precision null,
  total_exec_time_ms_delta double precision not null,
  rows_delta bigint null,
  shared_blks_hit_delta bigint null,
  shared_blks_read_delta bigint null,
  shared_blks_dirtied_delta bigint null,
  shared_blks_written_delta bigint null,
  local_blks_hit_delta bigint null,
  local_blks_read_delta bigint null,
  local_blks_dirtied_delta bigint null,
  local_blks_written_delta bigint null,
  temp_blks_read_delta bigint null,
  temp_blks_written_delta bigint null,
  blk_read_time_ms_delta double precision null,
  blk_write_time_ms_delta double precision null,
  wal_records_delta bigint null,
  wal_fpi_delta bigint null,
  wal_bytes_delta numeric null,
  jit_generation_time_ms_delta double precision null,
  jit_inlining_time_ms_delta double precision null,
  jit_optimization_time_ms_delta double precision null,
  jit_emission_time_ms_delta double precision null,
  primary key (sample_ts, instance_pk, statement_series_id),
  constraint ck_pgss_delta_calls check (calls_delta >= 0),
  constraint ck_pgss_delta_plans check (plans_delta is null or plans_delta >= 0),
  constraint ck_pgss_delta_exec_time check (total_exec_time_ms_delta >= 0),
  constraint ck_pgss_delta_plan_time check (total_plan_time_ms_delta is null or total_plan_time_ms_delta >= 0),
  constraint ck_pgss_delta_rows check (rows_delta is null or rows_delta >= 0),
  constraint ck_pgss_delta_wal_bytes check (wal_bytes_delta is null or wal_bytes_delta >= 0)
) partition by range (sample_ts);

-- pg_stat_database delta: database bazlı istatistik farkları
create table if not exists fact.pg_database_delta (
  sample_ts timestamptz not null,
  instance_pk bigint not null,
  dbid oid not null,
  datname text not null,
  numbackends integer null,
  xact_commit_delta bigint not null,
  xact_rollback_delta bigint not null,
  blks_read_delta bigint not null,
  blks_hit_delta bigint not null,
  tup_returned_delta bigint not null,
  tup_fetched_delta bigint not null,
  tup_inserted_delta bigint not null,
  tup_updated_delta bigint not null,
  tup_deleted_delta bigint not null,
  conflicts_delta bigint null,
  temp_files_delta bigint null,
  temp_bytes_delta bigint null,
  deadlocks_delta bigint null,
  checksum_failures_delta bigint null,
  blk_read_time_ms_delta double precision null,
  blk_write_time_ms_delta double precision null,
  session_time_ms_delta double precision null,
  active_time_ms_delta double precision null,
  idle_in_transaction_time_ms_delta double precision null,
  primary key (sample_ts, instance_pk, dbid),
  constraint ck_pg_database_numbackends check (numbackends is null or numbackends >= 0),
  constraint ck_pg_database_commit check (xact_commit_delta >= 0),
  constraint ck_pg_database_rollback check (xact_rollback_delta >= 0),
  constraint ck_pg_database_blks_read check (blks_read_delta >= 0),
  constraint ck_pg_database_blks_hit check (blks_hit_delta >= 0)
) partition by range (sample_ts);

-- pg_stat_user_tables + pg_statio_user_tables delta
create table if not exists fact.pg_table_stat_delta (
  sample_ts timestamptz not null,
  instance_pk bigint not null,
  dbid oid not null,
  relid oid not null,
  schemaname text not null,
  relname text not null,
  seq_scan_delta bigint null,
  seq_tup_read_delta bigint null,
  idx_scan_delta bigint null,
  idx_tup_fetch_delta bigint null,
  n_tup_ins_delta bigint null,
  n_tup_upd_delta bigint null,
  n_tup_del_delta bigint null,
  n_tup_hot_upd_delta bigint null,
  vacuum_count_delta bigint null,
  autovacuum_count_delta bigint null,
  analyze_count_delta bigint null,
  autoanalyze_count_delta bigint null,
  heap_blks_read_delta bigint null,
  heap_blks_hit_delta bigint null,
  idx_blks_read_delta bigint null,
  idx_blks_hit_delta bigint null,
  toast_blks_read_delta bigint null,
  toast_blks_hit_delta bigint null,
  tidx_blks_read_delta bigint null,
  tidx_blks_hit_delta bigint null,
  n_live_tup_estimate bigint null,
  n_dead_tup_estimate bigint null,
  n_mod_since_analyze bigint null,
  primary key (sample_ts, instance_pk, dbid, relid),
  constraint ck_pg_table_stat_seq_scan check (seq_scan_delta is null or seq_scan_delta >= 0),
  constraint ck_pg_table_stat_seq_tup_read check (seq_tup_read_delta is null or seq_tup_read_delta >= 0),
  constraint ck_pg_table_stat_idx_scan check (idx_scan_delta is null or idx_scan_delta >= 0),
  constraint ck_pg_table_stat_idx_tup_fetch check (idx_tup_fetch_delta is null or idx_tup_fetch_delta >= 0),
  constraint ck_pg_table_stat_live_tup check (n_live_tup_estimate is null or n_live_tup_estimate >= 0),
  constraint ck_pg_table_stat_dead_tup check (n_dead_tup_estimate is null or n_dead_tup_estimate >= 0),
  constraint ck_pg_table_stat_mod_since_analyze check (n_mod_since_analyze is null or n_mod_since_analyze >= 0)
) partition by range (sample_ts);

-- pg_stat_user_indexes + pg_statio_user_indexes delta
create table if not exists fact.pg_index_stat_delta (
  sample_ts timestamptz not null,
  instance_pk bigint not null,
  dbid oid not null,
  table_relid oid not null,
  index_relid oid not null,
  schemaname text not null,
  table_relname text not null,
  index_relname text not null,
  idx_scan_delta bigint null,
  idx_tup_read_delta bigint null,
  idx_tup_fetch_delta bigint null,
  idx_blks_read_delta bigint null,
  idx_blks_hit_delta bigint null,
  primary key (sample_ts, instance_pk, dbid, index_relid),
  constraint ck_pg_index_stat_scan check (idx_scan_delta is null or idx_scan_delta >= 0),
  constraint ck_pg_index_stat_tup_read check (idx_tup_read_delta is null or idx_tup_read_delta >= 0),
  constraint ck_pg_index_stat_tup_fetch check (idx_tup_fetch_delta is null or idx_tup_fetch_delta >= 0),
  constraint ck_pg_index_stat_blks_read check (idx_blks_read_delta is null or idx_blks_read_delta >= 0),
  constraint ck_pg_index_stat_blks_hit check (idx_blks_hit_delta is null or idx_blks_hit_delta >= 0)
) partition by range (sample_ts);

-- Cluster seviyesi metrikler: bgwriter, wal, checkpointer (key-value model)
create table if not exists fact.pg_cluster_delta (
  sample_ts timestamptz not null,
  instance_pk bigint not null,
  metric_family text not null,
  metric_name text not null,
  metric_value_num numeric not null,
  primary key (sample_ts, instance_pk, metric_family, metric_name),
  constraint ck_pg_cluster_metric_family check (metric_family <> ''),
  constraint ck_pg_cluster_metric_name check (metric_name <> '')
) partition by range (sample_ts);

-- pg_stat_io delta: PG16+ I/O istatistikleri (dedicated tablo)
create table if not exists fact.pg_io_stat_delta (
  sample_ts              timestamptz not null,
  instance_pk            bigint not null,
  backend_type           text not null,
  object                 text not null,
  context                text not null,
  reads_delta            bigint null,
  read_time_ms_delta     double precision null,
  writes_delta           bigint null,
  write_time_ms_delta    double precision null,
  extends_delta          bigint null,
  extend_time_ms_delta   double precision null,
  hits_delta             bigint null,
  evictions_delta        bigint null,
  reuses_delta           bigint null,
  fsyncs_delta           bigint null,
  fsync_time_ms_delta    double precision null,
  primary key (sample_ts, instance_pk, backend_type, object, context)
) partition by range (sample_ts);

-- pg_stat_activity snapshot: tüm session'ların anlık durumu
create table if not exists fact.pg_activity_snapshot (
  snapshot_ts       timestamptz not null,
  instance_pk       bigint not null,
  pid               integer not null,
  datname           text null,
  usename           text null,
  application_name  text null,
  client_addr       inet null,
  backend_start     timestamptz null,
  xact_start        timestamptz null,
  query_start       timestamptz null,
  state_change      timestamptz null,
  state             text null,
  wait_event_type   text null,
  wait_event        text null,
  query             text null,
  backend_type      text null,
  primary key (snapshot_ts, instance_pk, pid)
) partition by range (snapshot_ts);

-- pg_locks snapshot: bekleyen lock'lar (granted = false)
create table if not exists fact.pg_lock_snapshot (
  snapshot_ts       timestamptz not null,
  instance_pk       bigint not null,
  pid               integer not null,
  locktype          text not null,
  database_oid      oid null,
  relation_oid      oid null,
  mode              text not null,
  granted           boolean not null,
  waitstart         timestamptz null,
  blocked_by_pids   integer[] null
) partition by range (snapshot_ts);

-- pg_stat_progress_* snapshot: uzun süren operasyonların ilerlemesi
create table if not exists fact.pg_progress_snapshot (
  snapshot_ts       timestamptz not null,
  instance_pk       bigint not null,
  pid               integer not null,
  command           text not null,
  datname           text null,
  relname           text null,
  phase             text null,
  blocks_total      bigint null,
  blocks_done       bigint null,
  tuples_total      bigint null,
  tuples_done       bigint null,
  progress_pct      double precision null,
  primary key (snapshot_ts, instance_pk, pid)
) partition by range (snapshot_ts);

-- pg_stat_replication snapshot: replica durumları (yalnızca primary'den)
create table if not exists fact.pg_replication_snapshot (
  snapshot_ts         timestamptz not null,
  instance_pk         bigint not null,
  pid                 integer not null,
  usename             text null,
  application_name    text null,
  client_addr         inet null,
  state               text null,
  sent_lsn            pg_lsn null,
  write_lsn           pg_lsn null,
  flush_lsn           pg_lsn null,
  replay_lsn          pg_lsn null,
  write_lag           interval null,
  flush_lag           interval null,
  replay_lag          interval null,
  sync_state          text null,
  replay_lag_bytes    bigint null,
  primary key (snapshot_ts, instance_pk, pid)
) partition by range (snapshot_ts);

-- Fact tabloları index'leri
create index if not exists ix_pgss_delta_instance_sample
  on fact.pgss_delta (instance_pk, sample_ts desc);

create index if not exists ix_pgss_delta_series_sample
  on fact.pgss_delta (statement_series_id, sample_ts desc);

create index if not exists ix_pgss_delta_instance_series_sample
  on fact.pgss_delta (instance_pk, statement_series_id, sample_ts desc);

create index if not exists ix_pg_database_delta_instance_sample
  on fact.pg_database_delta (instance_pk, sample_ts desc);

create index if not exists ix_pg_database_delta_instance_dbid_sample
  on fact.pg_database_delta (instance_pk, dbid, sample_ts desc);

create index if not exists ix_pg_database_delta_instance_datname_sample
  on fact.pg_database_delta (instance_pk, datname, sample_ts desc);

create index if not exists ix_pg_table_stat_instance_sample
  on fact.pg_table_stat_delta (instance_pk, sample_ts desc);

create index if not exists ix_pg_table_stat_instance_rel_sample
  on fact.pg_table_stat_delta (instance_pk, dbid, relid, sample_ts desc);

create index if not exists ix_pg_table_stat_instance_name_sample
  on fact.pg_table_stat_delta (instance_pk, dbid, schemaname, relname, sample_ts desc);

create index if not exists ix_pg_index_stat_instance_sample
  on fact.pg_index_stat_delta (instance_pk, sample_ts desc);

create index if not exists ix_pg_index_stat_instance_index_sample
  on fact.pg_index_stat_delta (instance_pk, dbid, index_relid, sample_ts desc);

create index if not exists ix_pg_index_stat_instance_table_sample
  on fact.pg_index_stat_delta (instance_pk, dbid, table_relid, sample_ts desc);

create index if not exists ix_pg_cluster_delta_instance_sample
  on fact.pg_cluster_delta (instance_pk, sample_ts desc);

create index if not exists ix_pg_cluster_delta_instance_family_name_sample
  on fact.pg_cluster_delta (instance_pk, metric_family, metric_name, sample_ts desc);

create index if not exists ix_pg_io_stat_delta_instance_sample
  on fact.pg_io_stat_delta (instance_pk, sample_ts desc);

create index if not exists ix_pg_io_stat_delta_instance_dims_sample
  on fact.pg_io_stat_delta (instance_pk, backend_type, object, context, sample_ts desc);

create index if not exists ix_pg_lock_snapshot_instance_snapshot
  on fact.pg_lock_snapshot (instance_pk, snapshot_ts desc);

create index if not exists ix_pg_lock_snapshot_instance_waiting
  on fact.pg_lock_snapshot (instance_pk, snapshot_ts desc)
  where granted = false;

create index if not exists ix_pg_progress_snapshot_instance_snapshot
  on fact.pg_progress_snapshot (instance_pk, snapshot_ts desc);

create index if not exists ix_pg_activity_snapshot_instance_snapshot
  on fact.pg_activity_snapshot (instance_pk, snapshot_ts desc);

create index if not exists ix_pg_activity_snapshot_instance_state
  on fact.pg_activity_snapshot (instance_pk, state, snapshot_ts desc);

create index if not exists ix_pg_replication_snapshot_instance_snapshot
  on fact.pg_replication_snapshot (instance_pk, snapshot_ts desc);
