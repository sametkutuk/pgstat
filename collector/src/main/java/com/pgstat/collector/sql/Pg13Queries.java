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

    /** PG13-14: pg_stat_subscription_stats yok (PG15+). */
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

    /** PG13-14: pg_stat_recovery_prefetch yok (PG15+). */
    @Override
    public String recoveryPrefetchQuery() {
        return null;
    }

    /** PG13: wal_status ve safe_wal_size var ama pg_stat_replication_slots PG14+. */
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
              s.wal_status,
              s.safe_wal_size,
              case when s.restart_lsn is null then null
                else (pg_current_wal_lsn() - s.restart_lsn)::bigint end as slot_lag_bytes,
              null::bigint as spill_txns,  null::bigint as spill_count,  null::bigint as spill_bytes,
              null::bigint as stream_txns, null::bigint as stream_count, null::bigint as stream_bytes,
              null::bigint as total_txns,  null::bigint as total_bytes
            from pg_replication_slots s
            """;
    }
}
