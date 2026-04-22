package com.pgstat.collector.sql;

/**
 * PG13 icin kaynak sorgulari.
 * pg11_12 uzerine eklenenler:
 * - toplevel kolonu (pg_stat_statements)
 * - wal_records, wal_fpi, wal_bytes (pg_stat_wal)
 * - jit_* kolonlari (pg_stat_statements)
 * - pg_stat_progress_analyze
 *
 * Hala yok:
 * - plans kolonu (PG14+)
 * - pg_stat_statements_info (PG14+)
 * - pg_stat_io (PG16+)
 * - pg_stat_checkpointer (PG17+)
 * - waitstart (PG14+)
 */
public class Pg13Queries extends Pg11_12Queries {

    @Override
    public String familyCode() {
        return "pg13";
    }

    // =========================================================================
    // Cluster metrikleri — pg_stat_wal eklendi
    // =========================================================================

    @Override
    public String walQuery() {
        return """
            select
              wal_records,
              wal_fpi,
              wal_bytes,
              wal_buffers_full,
              wal_write,
              wal_sync,
              wal_write_time,
              wal_sync_time
            from pg_stat_wal
            """;
    }

    // =========================================================================
    // Progress — analyze eklendi
    // =========================================================================

    @Override
    public String progressAnalyzeQuery() {
        return """
            select
              p.pid, 'ANALYZE' as command,
              d.datname, c.relname,
              p.phase,
              p.sample_blks_total as blocks_total,
              p.sample_blks_scanned as blocks_done,
              p.ext_stats_total as tuples_total,
              p.ext_stats_computed as tuples_done,
              case when p.sample_blks_total > 0
                then round(100.0 * p.sample_blks_scanned / p.sample_blks_total, 2)
                else null end as progress_pct
            from pg_stat_progress_analyze p
            left join pg_database d on d.oid = p.datid
            left join pg_class c on c.oid = p.relid
            """;
    }

    // =========================================================================
    // Statements — toplevel ve jit eklendi
    // =========================================================================

    @Override
    public String pgssStatsQuery() {
        // PG13: toplevel, wal, jit var; plans yok
        return """
            select
              userid, dbid, queryid,
              toplevel,
              calls,
              0::bigint as plans,
              0::double precision as total_plan_time,
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
    // Per-database — session_time/active_time yok (PG14+)
    // =========================================================================

    // databaseStatsQuery() → Pg11_12 kalitim ile ayni
}
