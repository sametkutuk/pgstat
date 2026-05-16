package com.pgstat.collector.sql;

/**
 * PG14, PG15, PG16 icin kaynak sorgulari.
 * pg13 uzerine eklenenler:
 * - plans kolonu (pg_stat_statements)
 * - pg_stat_statements_info (PG14+)
 * - waitstart (pg_locks, PG14+)
 * - session_time / active_time / idle_in_transaction_time (pg_stat_database, PG14+)
 * - pg_stat_io (PG16+)
 *
 * Hala yok:
 * - pg_stat_checkpointer ayri view (PG17+)
 */
public class Pg14_16Queries extends Pg13Queries {

    @Override
    public String familyCode() {
        return "pg14_16";
    }

    // =========================================================================
    // Discovery — pgss_info eklendi
    // =========================================================================

    @Override
    public String computeQueryIdQuery() {
        return "select current_setting('compute_query_id', true) as compute_query_id";
    }

    @Override
    public boolean supportsPgssInfo() {
        return true;
    }

    @Override
    public String pgssInfoQuery(String pgssInfoRelation) {
        return """
            select
              dealloc as stats_reset_count,
              stats_reset as last_stats_reset
            from %s
            """.formatted(pgssInfoRelation);
    }

    // =========================================================================
    // Cluster — pg_stat_io eklendi (PG16+)
    // =========================================================================

    @Override
    public String ioStatQuery() {
        // PG16+: writebacks, writeback_time, op_bytes, stats_reset eklendi
        // PG18'de read_bytes/write_bytes/extend_bytes eklendi, op_bytes kaldirildi — to_jsonb
        return """
            with src as (
              select to_jsonb(s.*) as j, s.* from pg_stat_io s
            )
            select
              backend_type, object, context,
              reads, read_time,
              writes, write_time,
              extends, extend_time,
              hits, evictions, reuses,
              fsyncs, fsync_time,
              coalesce((j->>'writebacks')::bigint, 0) as writebacks,
              coalesce((j->>'writeback_time')::double precision, 0) as writeback_time,
              (j->>'op_bytes')::bigint as op_bytes,
              (j->>'read_bytes')::numeric as read_bytes,
              (j->>'write_bytes')::numeric as write_bytes,
              (j->>'extend_bytes')::numeric as extend_bytes,
              (j->>'stats_reset')::timestamptz as stats_reset
            from src
            """;
    }

    // =========================================================================
    // Lock — waitstart eklendi (PG14+)
    // =========================================================================

    // Activity — query_id eklendi (PG14+)
    @Override
    public String activityQuery() {
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
              leader_pid,
              query_id
            from pg_stat_activity
            where pid <> pg_backend_pid()
            """;
    }

    // Table stats — PG16+ last_seq_scan, last_idx_scan, n_tup_newpage_upd (to_jsonb safe-lookup)
    @Override
    public String tableStatsQuery() {
        return """
            with src as (
              select to_jsonb(s.*) as j, s.*, io.*
              from pg_stat_user_tables s
              left join pg_statio_user_tables io on io.relid = s.relid
            )
            select
              relid, schemaname, relname,
              seq_scan, seq_tup_read,
              coalesce(idx_scan, 0) as idx_scan,
              coalesce(idx_tup_fetch, 0) as idx_tup_fetch,
              n_tup_ins, n_tup_upd, n_tup_del, n_tup_hot_upd,
              vacuum_count, autovacuum_count,
              analyze_count, autoanalyze_count,
              coalesce(heap_blks_read, 0) as heap_blks_read,
              coalesce(heap_blks_hit, 0) as heap_blks_hit,
              coalesce(idx_blks_read, 0) as idx_blks_read,
              coalesce(idx_blks_hit, 0) as idx_blks_hit,
              coalesce(toast_blks_read, 0) as toast_blks_read,
              coalesce(toast_blks_hit, 0) as toast_blks_hit,
              coalesce(tidx_blks_read, 0) as tidx_blks_read,
              coalesce(tidx_blks_hit, 0) as tidx_blks_hit,
              n_live_tup, n_dead_tup, n_mod_since_analyze,
              last_vacuum, last_autovacuum,
              last_analyze, last_autoanalyze,
              n_ins_since_vacuum,
              (j->>'last_seq_scan')::timestamptz as last_seq_scan,
              (j->>'last_idx_scan')::timestamptz as last_idx_scan,
              coalesce((j->>'n_tup_newpage_upd')::bigint, 0) as n_tup_newpage_upd
            from src
            """;
    }

    // Index stats — PG16+ last_idx_scan (to_jsonb safe-lookup)
    @Override
    public String indexStatsQuery() {
        return """
            with src as (
              select to_jsonb(s.*) as j, s.*,
                coalesce(io.idx_blks_read, 0) as io_idx_blks_read,
                coalesce(io.idx_blks_hit, 0) as io_idx_blks_hit,
                ix.indisvalid, ix.indisready, ix.indisprimary, ix.indisunique
              from pg_stat_user_indexes s
              left join pg_statio_user_indexes io on io.indexrelid = s.indexrelid
              left join pg_index ix on ix.indexrelid = s.indexrelid
            )
            select
              relid as table_relid,
              indexrelid as index_relid,
              schemaname,
              relname as table_relname,
              indexrelname as index_relname,
              idx_scan, idx_tup_read, idx_tup_fetch,
              io_idx_blks_read as idx_blks_read,
              io_idx_blks_hit as idx_blks_hit,
              indisvalid as is_valid,
              indisready as is_ready,
              indisprimary as is_primary,
              indisunique as is_unique,
              (j->>'last_idx_scan')::timestamptz as last_idx_scan
            from src
            """;
    }

    @Override
    public String lockQuery() {
        return """
            select
              l.pid,
              l.locktype,
              l.database as database_oid,
              l.relation as relation_oid,
              l.mode,
              l.granted,
              l.waitstart,
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

    // =========================================================================
    // Statements — plans kolonu eklendi
    // =========================================================================

    @Override
    public String pgssStatsQuery(String pgssFunction) {
        // PG14-16: toplevel, plans, jit detay var.
        // PG15+ temp_blk_read/write_time, stats_since, minmax_stats_since, jit_*_count
        // PG16+ jit_deform_count/time
        // to_jsonb safe-lookup ile kolon yoksa null/0 doner.
        return """
            with src as (
              select to_jsonb(s.*) as j, s.* from %s(false) s
            )
            select
              userid, dbid, queryid,
              toplevel,
              calls,
              plans,
              total_plan_time,
              total_exec_time,
              min_exec_time, max_exec_time, stddev_exec_time,
              min_plan_time, max_plan_time, stddev_plan_time,
              coalesce((j->>'mean_exec_time')::double precision, 0) as mean_exec_time,
              coalesce((j->>'mean_plan_time')::double precision, 0) as mean_plan_time,
              rows,
              shared_blks_hit, shared_blks_read,
              shared_blks_dirtied, shared_blks_written,
              local_blks_hit, local_blks_read,
              local_blks_dirtied, local_blks_written,
              temp_blks_read, temp_blks_written,
              blk_read_time, blk_write_time,
              coalesce((j->>'temp_blk_read_time')::double precision, 0)  as temp_blk_read_time,
              coalesce((j->>'temp_blk_write_time')::double precision, 0) as temp_blk_write_time,
              wal_records, wal_fpi, wal_bytes,
              0::bigint as wal_buffers_full,
              coalesce((j->>'jit_functions')::bigint, 0) as jit_functions,
              jit_generation_time,
              jit_inlining_time,
              jit_optimization_time,
              jit_emission_time,
              coalesce((j->>'jit_deform_count')::bigint, 0)         as jit_deform_count,
              coalesce((j->>'jit_deform_time')::double precision, 0) as jit_deform_time,
              coalesce((j->>'jit_inlining_count')::bigint, 0)       as jit_inlining_count,
              coalesce((j->>'jit_optimization_count')::bigint, 0)   as jit_optimization_count,
              coalesce((j->>'jit_emission_count')::bigint, 0)       as jit_emission_count,
              (j->>'stats_since')::timestamptz          as stats_since,
              (j->>'minmax_stats_since')::timestamptz   as minmax_stats_since,
              0::bigint as parallel_workers_to_launch,
              0::bigint as parallel_workers_launched,
              0::double precision as shared_blk_read_time,
              0::double precision as shared_blk_write_time,
              0::double precision as local_blk_read_time,
              0::double precision as local_blk_write_time
            from src
            """.formatted(pgssFunction);
    }

    // =========================================================================
    // Per-database — session metrikleri eklendi (PG14+)
    // =========================================================================

    @Override
    public String databaseStatsQuery() {
        // PG14+: session_time, sessions, sessions_* eklendi
        // PG16+: parallel_workers yok (PG18+) — to_jsonb safe-lookup
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
              session_time,
              active_time,
              idle_in_transaction_time,
              sessions,
              sessions_abandoned,
              sessions_fatal,
              sessions_killed,
              stats_reset,
              (j->>'checksum_last_failure')::timestamptz as checksum_last_failure,
              coalesce((j->>'parallel_workers_to_launch')::bigint, 0) as parallel_workers_to_launch,
              coalesce((j->>'parallel_workers_launched')::bigint, 0) as parallel_workers_launched
            from src
            """;
    }

    /**
     * PG14'te subscription_stats yok, PG15+ var. Pragmatik: stats'li sorgu ile
     * dene; PG14'te collector try/catch ile yakalar, satir atlanir.
     */
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
              ss.apply_error_count,
              ss.sync_error_count,
              ss.stats_reset
            from pg_stat_subscription s
            left join pg_stat_subscription_stats ss on ss.subid = s.subid
            """;
    }

    /** PG15+ icin recovery_prefetch mevcut. */
    @Override
    public String recoveryPrefetchQuery() {
        return """
            select
              prefetch, hit, skip_init, skip_new, skip_fpw, skip_rep,
              stats_reset, wal_distance, block_distance, io_depth
            from pg_stat_recovery_prefetch
            """;
    }
}
