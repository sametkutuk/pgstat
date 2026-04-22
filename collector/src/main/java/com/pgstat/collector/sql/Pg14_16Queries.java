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
    public String pgssInfoQuery() {
        return """
            select
              dealloc as stats_reset_count,
              stats_reset as last_stats_reset
            from pg_stat_statements_info
            """;
    }

    // =========================================================================
    // Cluster — pg_stat_io eklendi (PG16+)
    // =========================================================================

    @Override
    public String ioStatQuery() {
        // PG16+ — pg_stat_io mevcut
        return """
            select
              backend_type, object, context,
              reads, read_time,
              writes, write_time,
              extends, extend_time,
              hits, evictions, reuses,
              fsyncs, fsync_time
            from pg_stat_io
            """;
    }

    // =========================================================================
    // Lock — waitstart eklendi (PG14+)
    // =========================================================================

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
    public String pgssStatsQuery() {
        // PG14+: plans, total_plan_time dahil
        return """
            select
              userid, dbid, queryid,
              toplevel,
              calls,
              plans,
              total_plan_time,
              total_exec_time,
              rows,
              shared_blks_hit, shared_blks_read,
              shared_blks_dirtied, shared_blks_written,
              local_blks_hit, local_blks_read,
              local_blks_dirtied, local_blks_written,
              temp_blks_read, temp_blks_written,
              blk_read_time, blk_write_time,
              wal_records, wal_fpi, wal_bytes,
              jit_generation_time,
              jit_inlining_time,
              jit_optimization_time,
              jit_emission_time
            from pg_stat_statements(false)
            """;
    }

    // =========================================================================
    // Per-database — session metrikleri eklendi (PG14+)
    // =========================================================================

    @Override
    public String databaseStatsQuery() {
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
              session_time,
              active_time,
              idle_in_transaction_time
            from pg_stat_database
            where datid != 0
            """;
    }
}
