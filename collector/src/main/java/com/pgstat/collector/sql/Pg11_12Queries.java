package com.pgstat.collector.sql;

/**
 * PG11 ve PG12 icin kaynak sorgulari.
 * - toplevel kolonu yok (pg_stat_statements'ta)
 * - plans kolonu yok
 * - wal_records / wal_bytes yok
 * - jit_* kolonlari yok
 * - pg_stat_io yok
 * - pg_stat_checkpointer yok (bgwriter icinde)
 * - waitstart yok (pg_locks'ta)
 * - pg_stat_progress_analyze yok (PG13+)
 */
public class Pg11_12Queries implements SourceQueries {

    @Override
    public String familyCode() {
        return "pg11_12";
    }

    // =========================================================================
    // Discovery
    // =========================================================================

    @Override
    public String discoveryQuery() {
        return """
            select
              current_setting('server_version_num')::integer as server_version_num,
              pg_is_in_recovery() as is_in_recovery,
              system_identifier
            from pg_control_system()
            """;
    }

    @Override
    public String databaseListQuery() {
        return """
            select oid as dbid, datname, datistemplate as is_template
            from pg_database
            where not datistemplate
              and datallowconn
            order by datname
            """;
    }

    @Override
    public String extensionCheckQuery() {
        return """
            select extname, extversion
            from pg_extension
            where extname in ('pg_stat_statements')
            """;
    }

    @Override
    public String computeQueryIdQuery() {
        // PG11-12'de compute_query_id yok; bos doner
        return "select null::text as compute_query_id";
    }

    @Override
    public String postmasterStartTimeQuery() {
        return "select pg_postmaster_start_time() as start_time";
    }

    // =========================================================================
    // Cluster metrikleri
    // =========================================================================

    @Override
    public String bgwriterQuery() {
        return """
            select
              checkpoints_timed,
              checkpoints_req,
              checkpoint_write_time,
              checkpoint_sync_time,
              buffers_checkpoint,
              buffers_clean,
              maxwritten_clean,
              buffers_backend,
              buffers_backend_fsync,
              buffers_alloc,
              stats_reset
            from pg_stat_bgwriter
            """;
    }

    // walQuery() → null (PG13+)
    // checkpointerQuery() → null (PG17+)
    // ioStatQuery() → null (PG16+)

    // =========================================================================
    // Activity / Replication / Lock / Progress
    // =========================================================================

    @Override
    public String activityQuery() {
        // PG11-12: leader_pid yok (PG13+), query_id yok (PG14+)
        return """
            select
              pid, datname, usename, application_name,
              client_addr::text, backend_start, xact_start,
              query_start, state_change, state,
              wait_event_type, wait_event,
              left(query, 1000) as query,
              backend_type,
              usesysid::bigint as usesysid,
              client_hostname,
              client_port,
              backend_xid::text as backend_xid,
              backend_xmin::text as backend_xmin,
              null::integer as leader_pid,
              null::bigint as query_id
            from pg_stat_activity
            where pid <> pg_backend_pid()
            """;
    }

    @Override
    public String replicationQuery() {
        // PG11-12: reply_time PG12'de eklendi — to_jsonb safe-lookup
        return """
            with src as (
              select to_jsonb(r.*) as j, r.* from pg_stat_replication r
            )
            select
              pid, usename, application_name,
              client_addr::text, state,
              sent_lsn::text, write_lsn::text, flush_lsn::text, replay_lsn::text,
              write_lag::text, flush_lag::text, replay_lag::text,
              sync_state,
              (sent_lsn - replay_lsn) as replay_lag_bytes,
              usesysid::bigint as usesysid,
              client_hostname,
              client_port,
              backend_start,
              backend_xmin::text as backend_xmin,
              sync_priority,
              (j->>'reply_time')::timestamptz as reply_time
            from src
            """;
    }

    @Override
    public String lockQuery() {
        // PG11-12: waitstart yok → NULL yazilir
        return """
            select
              l.pid,
              l.locktype,
              l.database as database_oid,
              l.relation as relation_oid,
              l.mode,
              l.granted,
              null::timestamptz as waitstart,
              array(
                select distinct bl.pid
                from pg_locks bl
                where bl.granted
                  and bl.locktype = l.locktype
                  and bl.database is not distinct from l.database
                  and bl.relation is not distinct from l.relation
                  and bl.mode != l.mode
                  and bl.pid != l.pid
              ) as blocked_by_pids
            from pg_locks l
            join pg_stat_activity a on a.pid = l.pid
            where l.granted = false
            """;
    }

    @Override
    public String progressVacuumQuery() {
        return """
            select
              p.pid, 'VACUUM' as command,
              d.datname, c.relname,
              null as phase,
              p.heap_blks_total as blocks_total,
              p.heap_blks_scanned as blocks_done,
              null::bigint as tuples_total,
              p.heap_blks_vacuumed as tuples_done,
              case when p.heap_blks_total > 0
                then round(100.0 * p.heap_blks_scanned / p.heap_blks_total, 2)
                else null end as progress_pct
            from pg_stat_progress_vacuum p
            left join pg_database d on d.oid = p.datid
            left join pg_class c on c.oid = p.relid
            """;
    }

    // progressAnalyzeQuery() → null (PG13+)

    @Override
    public String progressCreateIndexQuery() {
        // PG12'de mevcut (PG11'de yok — bu class PG11+12 icin, PG12'de var)
        return """
            select
              p.pid, p.datid::bigint, d.datname, p.relid::bigint,
              p.index_relid::bigint, p.command::text, p.phase,
              p.lockers_total, p.lockers_done, p.current_locker_pid,
              p.blocks_total, p.blocks_done, p.tuples_total, p.tuples_done,
              p.partitions_total, p.partitions_done
            from pg_stat_progress_create_index p
            left join pg_database d on d.oid = p.datid
            """;
    }

    /** PG12+: pg_stat_progress_cluster (CLUSTER/VACUUM FULL). */
    @Override
    public String progressClusterQuery() {
        return """
            select
              p.pid, p.datid::bigint, d.datname, p.relid::bigint,
              p.command::text, p.phase,
              p.cluster_index_relid::bigint,
              p.heap_tuples_scanned, p.heap_tuples_written,
              p.heap_blks_total, p.heap_blks_scanned,
              p.index_rebuild_count
            from pg_stat_progress_cluster p
            left join pg_database d on d.oid = p.datid
            """;
    }

    // =========================================================================
    // Statements
    // =========================================================================

    @Override
    public String pgssStatsQuery(String pgssFunction) {
        // PG11-12: toplevel, plans, wal, jit yok; min/max/stddev sadece exec icin var
        return """
            select
              userid, dbid, queryid,
              null::boolean as toplevel,
              calls,
              0::bigint as plans,
              0::double precision as total_plan_time,
              total_time as total_exec_time,
              min_time as min_exec_time,
              max_time as max_exec_time,
              stddev_time as stddev_exec_time,
              0::double precision as min_plan_time,
              0::double precision as max_plan_time,
              0::double precision as stddev_plan_time,
              mean_time as mean_exec_time,
              0::double precision as mean_plan_time,
              rows,
              shared_blks_hit, shared_blks_read,
              shared_blks_dirtied, shared_blks_written,
              local_blks_hit, local_blks_read,
              local_blks_dirtied, local_blks_written,
              temp_blks_read, temp_blks_written,
              blk_read_time, blk_write_time,
              0::double precision as temp_blk_read_time,
              0::double precision as temp_blk_write_time,
              0::bigint as wal_records,
              0::bigint as wal_fpi,
              0::bigint as wal_bytes,
              0::bigint as wal_buffers_full,
              0::bigint as jit_functions,
              0::double precision as jit_generation_time,
              0::double precision as jit_inlining_time,
              0::double precision as jit_optimization_time,
              0::double precision as jit_emission_time,
              0::bigint as jit_deform_count,
              0::double precision as jit_deform_time,
              0::bigint as jit_inlining_count,
              0::bigint as jit_optimization_count,
              0::bigint as jit_emission_count,
              null::timestamptz as stats_since,
              null::timestamptz as minmax_stats_since,
              0::bigint as parallel_workers_to_launch,
              0::bigint as parallel_workers_launched,
              0::double precision as shared_blk_read_time,
              0::double precision as shared_blk_write_time,
              0::double precision as local_blk_read_time,
              0::double precision as local_blk_write_time
            from %s(false)
            """.formatted(pgssFunction);
    }

    @Override
    public String pgssTextQuery(String pgssFunction) {
        return """
            select queryid, query
            from %s(true)
            """.formatted(pgssFunction);
    }

    // =========================================================================
    // Per-database istatistikler
    // =========================================================================

    @Override
    public String databaseStatsQuery() {
        // PG11-12: session_time, active_time, idle_in_transaction_time yok
        // sessions/sessions_* yok (PG14+), checksum_last_failure PG12'de eklendi (to_jsonb)
        return """
            with src as (
              select to_jsonb(d.*) as j, d.* from pg_stat_database d where datid != 0
            )
            select
              datid as dbid, datname, numbackends,
              xact_commit, xact_rollback,
              blks_read, blks_hit,
              tup_returned, tup_fetched,
              tup_inserted, tup_updated, tup_deleted,
              conflicts,
              temp_files, temp_bytes,
              deadlocks,
              coalesce(checksum_failures, 0) as checksum_failures,
              blk_read_time, blk_write_time,
              0::double precision as session_time,
              0::double precision as active_time,
              0::double precision as idle_in_transaction_time,
              0::bigint as sessions,
              0::bigint as sessions_abandoned,
              0::bigint as sessions_fatal,
              0::bigint as sessions_killed,
              stats_reset,
              (j->>'checksum_last_failure')::timestamptz as checksum_last_failure,
              0::bigint as parallel_workers_to_launch,
              0::bigint as parallel_workers_launched
            from src
            """;
    }

    @Override
    public String tableStatsQuery() {
        // PG11-12: n_ins_since_vacuum yok (PG13+), last_seq_scan/last_idx_scan yok (PG16+),
        // n_tup_newpage_upd yok (PG16+)
        return """
            select
              s.relid, s.schemaname, s.relname,
              s.seq_scan, s.seq_tup_read,
              coalesce(s.idx_scan, 0) as idx_scan,
              coalesce(s.idx_tup_fetch, 0) as idx_tup_fetch,
              s.n_tup_ins, s.n_tup_upd, s.n_tup_del, s.n_tup_hot_upd,
              s.vacuum_count, s.autovacuum_count,
              s.analyze_count, s.autoanalyze_count,
              coalesce(io.heap_blks_read, 0) as heap_blks_read,
              coalesce(io.heap_blks_hit, 0) as heap_blks_hit,
              coalesce(io.idx_blks_read, 0) as idx_blks_read,
              coalesce(io.idx_blks_hit, 0) as idx_blks_hit,
              coalesce(io.toast_blks_read, 0) as toast_blks_read,
              coalesce(io.toast_blks_hit, 0) as toast_blks_hit,
              coalesce(io.tidx_blks_read, 0) as tidx_blks_read,
              coalesce(io.tidx_blks_hit, 0) as tidx_blks_hit,
              s.n_live_tup, s.n_dead_tup, s.n_mod_since_analyze,
              s.last_vacuum, s.last_autovacuum,
              s.last_analyze, s.last_autoanalyze,
              0::bigint as n_ins_since_vacuum,
              null::timestamptz as last_seq_scan,
              null::timestamptz as last_idx_scan,
              0::bigint as n_tup_newpage_upd,
              0::double precision as total_vacuum_time,
              0::double precision as total_autovacuum_time,
              0::double precision as total_analyze_time,
              0::double precision as total_autoanalyze_time
            from pg_stat_user_tables s
            left join pg_statio_user_tables io on io.relid = s.relid
            """;
    }

    @Override
    public String indexStatsQuery() {
        // PG11-12: last_idx_scan yok (PG16+)
        return """
            select
              s.relid as table_relid,
              s.indexrelid as index_relid,
              s.schemaname,
              s.relname as table_relname,
              s.indexrelname as index_relname,
              s.idx_scan, s.idx_tup_read, s.idx_tup_fetch,
              coalesce(io.idx_blks_read, 0) as idx_blks_read,
              coalesce(io.idx_blks_hit, 0) as idx_blks_hit,
              ix.indisvalid as is_valid,
              ix.indisready as is_ready,
              ix.indisprimary as is_primary,
              ix.indisunique as is_unique,
              null::timestamptz as last_idx_scan
            from pg_stat_user_indexes s
            left join pg_statio_user_indexes io on io.indexrelid = s.indexrelid
            left join pg_index ix on ix.indexrelid = s.indexrelid
            """;
    }

    /** PG11-12: pg_stat_slru yok. */
    @Override
    public String slruQuery() {
        return null;
    }

    /** PG11-12: pg_stat_subscription var ama pg_stat_subscription_stats yok. */
    @Override
    public String subscriptionQuery() {
        return """
            select
              s.subid::bigint                    as subid,
              s.subname,
              s.pid,
              s.relid::bigint                    as relid,
              s.received_lsn::text               as received_lsn,
              s.last_msg_send_time,
              s.last_msg_receipt_time,
              s.latest_end_lsn::text             as latest_end_lsn,
              s.latest_end_time,
              case when s.received_lsn is null or s.latest_end_lsn is null
                then null
                else (s.received_lsn - s.latest_end_lsn)::bigint
              end as lag_bytes,
              null::bigint      as apply_error_count,
              null::bigint      as sync_error_count,
              null::timestamptz as stats_reset,
              null::integer     as leader_pid,
              'apply'::text     as worker_type,
              0::bigint as confl_insert_exists,
              0::bigint as confl_update_origin_differs,
              0::bigint as confl_update_exists,
              0::bigint as confl_update_missing,
              0::bigint as confl_delete_origin_differs,
              0::bigint as confl_delete_missing,
              0::bigint as confl_multiple_unique_conflicts
            from pg_stat_subscription s
            """;
    }

    /** PG11-12: pg_stat_recovery_prefetch yok. */
    @Override
    public String recoveryPrefetchQuery() {
        return null;
    }

    /** PG11-12: pg_stat_replication_slots yok, wal_status/safe_wal_size yok. */
    @Override
    public String replicationSlotsQuery() {
        return """
            select
              s.slot_name,
              s.plugin,
              s.slot_type,
              s.database,
              s.active,
              s.active_pid,
              case when s.xmin is null then null else s.xmin::text::bigint end as xmin_int,
              case when s.catalog_xmin is null then null else s.catalog_xmin::text::bigint end as catalog_xmin_int,
              s.restart_lsn::text         as restart_lsn,
              s.confirmed_flush_lsn::text as confirmed_flush_lsn,
              null::text   as wal_status,
              null::bigint as safe_wal_size,
              case when s.restart_lsn is null then null
                else (pg_current_wal_lsn() - s.restart_lsn)::bigint end as slot_lag_bytes,
              null::bigint as spill_txns,  null::bigint as spill_count,  null::bigint as spill_bytes,
              null::bigint as stream_txns, null::bigint as stream_count, null::bigint as stream_bytes,
              null::bigint as total_txns,  null::bigint as total_bytes,
              null::timestamptz as stats_reset,
              s.temporary,
              null::boolean as two_phase,
              null::boolean as conflicting,
              null::text as invalidation_reason,
              null::boolean as failover,
              null::boolean as synced
            from pg_replication_slots s
            """;
    }
}
