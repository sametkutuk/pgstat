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
              buffers_alloc
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
        return """
            select
              pid, datname, usename, application_name,
              client_addr::text, backend_start, xact_start,
              query_start, state_change, state,
              wait_event_type, wait_event,
              left(query, 1000) as query,
              backend_type
            from pg_stat_activity
            where pid <> pg_backend_pid()
            """;
    }

    @Override
    public String replicationQuery() {
        return """
            select
              pid, usename, application_name,
              client_addr::text, state,
              sent_lsn::text, write_lsn::text, flush_lsn::text, replay_lsn::text,
              write_lag::text, flush_lag::text, replay_lag::text,
              sync_state,
              (sent_lsn - replay_lsn) as replay_lag_bytes
            from pg_stat_replication
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
        // PG12'de mevcut
        return """
            select
              p.pid, 'CREATE INDEX' as command,
              d.datname, c.relname,
              p.phase,
              p.blocks_total, p.blocks_done,
              p.tuples_total, p.tuples_done,
              case when p.blocks_total > 0
                then round(100.0 * p.blocks_done / p.blocks_total, 2)
                else null end as progress_pct
            from pg_stat_progress_create_index p
            left join pg_database d on d.oid = p.datid
            left join pg_class c on c.oid = p.relid
            """;
    }

    // =========================================================================
    // Statements
    // =========================================================================

    @Override
    public String pgssStatsQuery() {
        // PG11-12: toplevel, plans, wal, jit yok
        return """
            select
              userid, dbid, queryid,
              null::boolean as toplevel,
              calls,
              0::bigint as plans,
              0::double precision as total_plan_time,
              total_time as total_exec_time,
              rows,
              shared_blks_hit, shared_blks_read,
              shared_blks_dirtied, shared_blks_written,
              local_blks_hit, local_blks_read,
              local_blks_dirtied, local_blks_written,
              temp_blks_read, temp_blks_written,
              blk_read_time, blk_write_time,
              0::bigint as wal_records,
              0::bigint as wal_fpi,
              0::bigint as wal_bytes,
              0::double precision as jit_generation_time,
              0::double precision as jit_inlining_time,
              0::double precision as jit_optimization_time,
              0::double precision as jit_emission_time
            from pg_stat_statements(false)
            """;
    }

    @Override
    public String pgssTextQuery() {
        return """
            select queryid, query
            from pg_stat_statements(true)
            """;
    }

    // =========================================================================
    // Per-database istatistikler
    // =========================================================================

    @Override
    public String databaseStatsQuery() {
        // PG11-12: session_time, active_time, idle_in_transaction_time yok
        return """
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
              0::double precision as idle_in_transaction_time
            from pg_stat_database
            where datid != 0
            """;
    }

    @Override
    public String tableStatsQuery() {
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
              s.n_live_tup, s.n_dead_tup, s.n_mod_since_analyze
            from pg_stat_user_tables s
            left join pg_statio_user_tables io on io.relid = s.relid
            """;
    }

    @Override
    public String indexStatsQuery() {
        return """
            select
              s.relid as table_relid,
              s.indexrelid as index_relid,
              s.schemaname,
              s.relname as table_relname,
              s.indexrelname as index_relname,
              s.idx_scan, s.idx_tup_read, s.idx_tup_fetch,
              coalesce(io.idx_blks_read, 0) as idx_blks_read,
              coalesce(io.idx_blks_hit, 0) as idx_blks_hit
            from pg_stat_user_indexes s
            left join pg_statio_user_indexes io on io.indexrelid = s.indexrelid
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
              null::timestamptz as stats_reset
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
              null::bigint as total_txns,  null::bigint as total_bytes
            from pg_replication_slots s
            """;
    }
}
