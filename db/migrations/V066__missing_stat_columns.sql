-- V066: Eksik PostgreSQL stat view kolonlarini ekle.
-- Tum kolonlar nullable — eski PG surumlerinde NULL doner.
-- Kaynak: postgresql.org/docs/{11..18}/monitoring-stats.html

-- =========================================================================
-- fact.pg_table_stat_delta — last_vacuum/analyze timestamps + PG13/16 kolonlari
-- =========================================================================
alter table fact.pg_table_stat_delta
  add column if not exists last_vacuum          timestamptz null,
  add column if not exists last_autovacuum      timestamptz null,
  add column if not exists last_analyze         timestamptz null,
  add column if not exists last_autoanalyze     timestamptz null,
  add column if not exists n_ins_since_vacuum   bigint null,
  add column if not exists last_seq_scan        timestamptz null,
  add column if not exists last_idx_scan        timestamptz null,
  add column if not exists n_tup_newpage_upd    bigint null;

comment on column fact.pg_table_stat_delta.last_vacuum is 'Son manuel vacuum zamani (tum PG surumlerinde mevcut)';
comment on column fact.pg_table_stat_delta.last_autovacuum is 'Son autovacuum zamani (tum PG surumlerinde mevcut)';
comment on column fact.pg_table_stat_delta.last_analyze is 'Son manuel analyze zamani (tum PG surumlerinde mevcut)';
comment on column fact.pg_table_stat_delta.last_autoanalyze is 'Son autoanalyze zamani (tum PG surumlerinde mevcut)';
comment on column fact.pg_table_stat_delta.n_ins_since_vacuum is 'Son vacuum sonrasi insert edilen satir tahmini (PG13+)';
comment on column fact.pg_table_stat_delta.last_seq_scan is 'Son sequential scan zamani (PG16+)';
comment on column fact.pg_table_stat_delta.last_idx_scan is 'Son index scan zamani (PG16+)';
comment on column fact.pg_table_stat_delta.n_tup_newpage_upd is 'Yeni sayfaya tasinan update sayisi (PG16+)';

-- =========================================================================
-- fact.pg_index_stat_delta — last_idx_scan (PG16+)
-- =========================================================================
alter table fact.pg_index_stat_delta
  add column if not exists last_idx_scan timestamptz null;

comment on column fact.pg_index_stat_delta.last_idx_scan is 'Son index scan zamani (PG16+)';

-- =========================================================================
-- fact.pg_activity_snapshot — query_id, leader_pid, ek kolonlar
-- =========================================================================
alter table fact.pg_activity_snapshot
  add column if not exists query_id         bigint null,
  add column if not exists leader_pid       integer null,
  add column if not exists usesysid         bigint null,
  add column if not exists client_hostname  text null,
  add column if not exists client_port      integer null,
  add column if not exists backend_xid      text null,
  add column if not exists backend_xmin     text null;

comment on column fact.pg_activity_snapshot.query_id is 'Query identifier (PG14+, compute_query_id=on)';
comment on column fact.pg_activity_snapshot.leader_pid is 'Parallel group leader PID (PG13+)';
comment on column fact.pg_activity_snapshot.usesysid is 'User OID (tum PG surumlerinde mevcut)';
comment on column fact.pg_activity_snapshot.client_hostname is 'Client hostname (tum PG surumlerinde mevcut, log_hostname=on gerekir)';
comment on column fact.pg_activity_snapshot.client_port is 'Client TCP port (tum PG surumlerinde mevcut)';
comment on column fact.pg_activity_snapshot.backend_xid is 'Backend current transaction ID (tum PG surumlerinde mevcut)';
comment on column fact.pg_activity_snapshot.backend_xmin is 'Backend xmin horizon (tum PG surumlerinde mevcut)';

-- =========================================================================
-- fact.pg_database_delta — sessions, stats_reset, checksum_last_failure, parallel_workers
-- =========================================================================
alter table fact.pg_database_delta
  add column if not exists sessions_delta           bigint null,
  add column if not exists sessions_abandoned_delta bigint null,
  add column if not exists sessions_fatal_delta     bigint null,
  add column if not exists sessions_killed_delta    bigint null,
  add column if not exists stats_reset              timestamptz null,
  add column if not exists checksum_last_failure    timestamptz null,
  add column if not exists parallel_workers_to_launch_delta bigint null,
  add column if not exists parallel_workers_launched_delta  bigint null;

comment on column fact.pg_database_delta.sessions_delta is 'Yeni oturum sayisi delta (PG14+)';
comment on column fact.pg_database_delta.sessions_abandoned_delta is 'Baglanti kopan oturum delta (PG14+)';
comment on column fact.pg_database_delta.sessions_fatal_delta is 'Fatal hata ile sonlanan oturum delta (PG14+)';
comment on column fact.pg_database_delta.sessions_killed_delta is 'Operator tarafindan sonlandirilan oturum delta (PG14+)';
comment on column fact.pg_database_delta.stats_reset is 'Son stats reset zamani (tum PG surumlerinde mevcut)';
comment on column fact.pg_database_delta.checksum_last_failure is 'Son checksum hatasi zamani (PG12+)';
comment on column fact.pg_database_delta.parallel_workers_to_launch_delta is 'Planlanan parallel worker delta (PG18+)';
comment on column fact.pg_database_delta.parallel_workers_launched_delta is 'Baslatilan parallel worker delta (PG18+)';

-- =========================================================================
-- fact.pg_replication_snapshot — ek kolonlar
-- =========================================================================
alter table fact.pg_replication_snapshot
  add column if not exists usesysid         bigint null,
  add column if not exists client_hostname  text null,
  add column if not exists client_port      integer null,
  add column if not exists backend_start    timestamptz null,
  add column if not exists backend_xmin     text null,
  add column if not exists sync_priority    integer null,
  add column if not exists reply_time       timestamptz null;

comment on column fact.pg_replication_snapshot.usesysid is 'WAL sender user OID (tum PG surumlerinde mevcut)';
comment on column fact.pg_replication_snapshot.client_hostname is 'Client hostname (tum PG surumlerinde mevcut)';
comment on column fact.pg_replication_snapshot.client_port is 'Client TCP port (tum PG surumlerinde mevcut)';
comment on column fact.pg_replication_snapshot.backend_start is 'WAL sender baslangic zamani (tum PG surumlerinde mevcut)';
comment on column fact.pg_replication_snapshot.backend_xmin is 'Standby xmin horizon (tum PG surumlerinde mevcut)';
comment on column fact.pg_replication_snapshot.sync_priority is 'Synchronous replication onceligi (tum PG surumlerinde mevcut)';
comment on column fact.pg_replication_snapshot.reply_time is 'Son reply mesaji zamani (PG12+)';

-- =========================================================================
-- fact.pg_replication_slot_snapshot — stats_reset
-- =========================================================================
alter table fact.pg_replication_slot_snapshot
  add column if not exists stats_reset timestamptz null;

comment on column fact.pg_replication_slot_snapshot.stats_reset is 'Son stats reset zamani (PG14+, pg_stat_replication_slots)';

-- =========================================================================
-- fact.pg_database_conflict_snapshot — datid, confl_active_logicalslot
-- =========================================================================
alter table fact.pg_database_conflict_snapshot
  add column if not exists datid                      bigint null,
  add column if not exists confl_active_logicalslot   bigint null;

comment on column fact.pg_database_conflict_snapshot.datid is 'Database OID (tum PG surumlerinde mevcut)';
comment on column fact.pg_database_conflict_snapshot.confl_active_logicalslot is 'Logical slot conflict sayisi (PG16+)';

-- =========================================================================
-- fact.pg_io_stat_delta — writebacks, writeback_time, op_bytes, stats_reset, PG18 byte kolonlari
-- =========================================================================
alter table fact.pg_io_stat_delta
  add column if not exists writebacks_delta       bigint null,
  add column if not exists writeback_time_ms_delta double precision null,
  add column if not exists op_bytes               bigint null,
  add column if not exists read_bytes_delta       numeric null,
  add column if not exists write_bytes_delta      numeric null,
  add column if not exists extend_bytes_delta     numeric null,
  add column if not exists stats_reset            timestamptz null;

comment on column fact.pg_io_stat_delta.writebacks_delta is 'Writeback islem sayisi delta (PG16+)';
comment on column fact.pg_io_stat_delta.writeback_time_ms_delta is 'Writeback suresi delta ms (PG16+)';
comment on column fact.pg_io_stat_delta.op_bytes is 'I/O birim boyutu (PG16-17, PG18 de kaldirildi)';
comment on column fact.pg_io_stat_delta.read_bytes_delta is 'Okunan byte delta (PG18+)';
comment on column fact.pg_io_stat_delta.write_bytes_delta is 'Yazilan byte delta (PG18+)';
comment on column fact.pg_io_stat_delta.extend_bytes_delta is 'Extend byte delta (PG18+)';
comment on column fact.pg_io_stat_delta.stats_reset is 'Son stats reset zamani (PG16+)';

-- =========================================================================
-- fact.pgss_delta — mean_exec_time, mean_plan_time, jit_*_count, blk split
-- =========================================================================
alter table fact.pgss_delta
  add column if not exists mean_exec_time_ms        double precision null,
  add column if not exists mean_plan_time_ms        double precision null,
  add column if not exists jit_inlining_count       bigint null,
  add column if not exists jit_optimization_count   bigint null,
  add column if not exists jit_emission_count       bigint null,
  add column if not exists shared_blk_read_time_ms_delta  double precision null,
  add column if not exists shared_blk_write_time_ms_delta double precision null,
  add column if not exists local_blk_read_time_ms_delta   double precision null,
  add column if not exists local_blk_write_time_ms_delta  double precision null;

comment on column fact.pgss_delta.mean_exec_time_ms is 'Ortalama calisma suresi ms (PG13+)';
comment on column fact.pgss_delta.mean_plan_time_ms is 'Ortalama planlama suresi ms (PG13+)';
comment on column fact.pgss_delta.jit_inlining_count is 'JIT inlining sayisi (PG15+)';
comment on column fact.pgss_delta.jit_optimization_count is 'JIT optimization sayisi (PG15+)';
comment on column fact.pgss_delta.jit_emission_count is 'JIT emission sayisi (PG15+)';
comment on column fact.pgss_delta.shared_blk_read_time_ms_delta is 'Shared blk okuma suresi delta ms (PG17+)';
comment on column fact.pgss_delta.shared_blk_write_time_ms_delta is 'Shared blk yazma suresi delta ms (PG17+)';
comment on column fact.pgss_delta.local_blk_read_time_ms_delta is 'Local blk okuma suresi delta ms (PG17+)';
comment on column fact.pgss_delta.local_blk_write_time_ms_delta is 'Local blk yazma suresi delta ms (PG17+)';

-- =========================================================================
-- fact.pg_subscription_snapshot — leader_pid (PG17+)
-- =========================================================================
alter table fact.pg_subscription_snapshot
  add column if not exists leader_pid integer null;

comment on column fact.pg_subscription_snapshot.leader_pid is 'Parallel apply worker leader PID (PG17+)';
