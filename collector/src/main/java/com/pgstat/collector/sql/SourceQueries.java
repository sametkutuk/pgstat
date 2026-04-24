package com.pgstat.collector.sql;

/**
 * Kaynak PostgreSQL'de calistirilacak SQL sorgulari arayuzu.
 * Her SQL family (pg11_12, pg13, pg14_16, pg17_18) farkli implementasyon sunar.
 *
 * Farklar:
 * - pg11_12: toplevel yok, plans yok, wal/jit kolonu yok, waitstart yok
 * - pg13: toplevel, wal_records/bytes, jit_* eklenir
 * - pg14_16: plans, pg_stat_statements_info, waitstart (PG14), pg_stat_io (PG16)
 * - pg17_18: pg_stat_checkpointer ayri view olarak eklenir
 *
 * Merkezi schema superset mantigi: kaynakta olmayan alanlar NULL yazilir.
 */
public interface SourceQueries {

    /** Bu implementasyonun family kodu (ornek: "pg11_12"). */
    String familyCode();

    // =========================================================================
    // Discovery sorgulari
    // =========================================================================

    /** server_version_num, pg_is_in_recovery(), system_identifier vb. */
    String discoveryQuery();

    /** Mevcut database listesi (pg_database). */
    String databaseListQuery();

    /** pg_stat_statements extension kontrolu. */
    String extensionCheckQuery();

    /** compute_query_id ayarini okur. */
    String computeQueryIdQuery();

    /** pg_postmaster_start_time() */
    String postmasterStartTimeQuery();

    /** pg_stat_statements_info (PG14+; eski surumlerde null doner). */
    default String pgssInfoQuery() { return null; }

    // =========================================================================
    // Cluster metrikleri
    // =========================================================================

    /** pg_stat_bgwriter — tum surumlerde mevcut. */
    String bgwriterQuery();

    /** pg_stat_wal — PG13+; pg11_12'de null. */
    default String walQuery() { return null; }

    /** pg_stat_checkpointer — PG17+; eski surumlerde checkpoint metrikleri bgwriter'da. */
    default String checkpointerQuery() { return null; }

    /** pg_stat_io — PG16+; eski surumlerde null. */
    default String ioStatQuery() { return null; }

    /**
     * WAL pozisyonu ve waldir disk kullanimi (PG10+).
     * Doner: current_wal_lsn::text, current_wal_file, wal_directory_size_byte, wal_file_count
     * Primary'de pg_current_wal_lsn(), standby'da pg_last_wal_replay_lsn() kullanilir.
     */
    default String walLsnQuery() {
        return """
            select
              case when pg_is_in_recovery()
                then pg_last_wal_replay_lsn()::text
                else pg_current_wal_lsn()::text
              end as current_wal_lsn,
              case when pg_is_in_recovery()
                then pg_walfile_name(pg_last_wal_replay_lsn())
                else pg_walfile_name(pg_current_wal_lsn())
              end as current_wal_file,
              (select coalesce(sum(size), 0)::bigint from pg_ls_waldir()) as wal_directory_size_byte,
              (select count(*)::int from pg_ls_waldir()) as wal_file_count
            """;
    }

    /** pg_stat_archiver (PG9.4+). */
    default String archiverQuery() {
        return """
            select
              archived_count,
              last_archived_wal,
              last_archived_time,
              failed_count,
              last_failed_wal,
              last_failed_time,
              stats_reset
            from pg_stat_archiver
            """;
    }

    /**
     * pg_replication_slots + pg_stat_replication_slots (PG14+ icin).
     * PG13 altinda wal_status, safe_wal_size, ve tum pg_stat_replication_slots
     * alanlari null doner (SourceQueries implementasyonlarinda override edilir).
     * Burada PG14+ versiyonu — override edenler farkli yazabilir.
     */
    default String replicationSlotsQuery() {
        return """
            select
              s.slot_name,
              s.plugin,
              s.slot_type,
              s.database,
              s.active,
              s.active_pid,
              s.xmin::text::bigint          as xmin_int,
              s.catalog_xmin::text::bigint  as catalog_xmin_int,
              s.restart_lsn::text           as restart_lsn,
              s.confirmed_flush_lsn::text   as confirmed_flush_lsn,
              s.wal_status,
              s.safe_wal_size,
              (pg_current_wal_lsn() - s.restart_lsn)::bigint as slot_lag_bytes,
              sr.spill_txns, sr.spill_count, sr.spill_bytes,
              sr.stream_txns, sr.stream_count, sr.stream_bytes,
              sr.total_txns, sr.total_bytes
            from pg_replication_slots s
            left join pg_stat_replication_slots sr on sr.slot_name = s.slot_name
            """;
    }

    /** pg_stat_database_conflicts (PG9.1+). */
    default String databaseConflictsQuery() {
        return """
            select
              datname,
              confl_tablespace,
              confl_lock,
              confl_snapshot,
              confl_bufferpin,
              confl_deadlock
            from pg_stat_database_conflicts
            where datname is not null
            """;
    }

    /**
     * pg_stat_slru (PG13+). Null doner PG11-12 icin (override).
     */
    default String slruQuery() {
        return """
            select
              name, blks_zeroed, blks_hit, blks_read, blks_written,
              blks_exists, flushes, truncates, stats_reset
            from pg_stat_slru
            """;
    }

    /**
     * pg_stat_subscription + pg_stat_subscription_stats (PG15+).
     * Alt versiyonlarda override — stats_* kolonlari null.
     */
    default String subscriptionQuery() {
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

    /**
     * pg_stat_recovery_prefetch (PG15+). Null doner alt versiyonlar icin.
     */
    default String recoveryPrefetchQuery() {
        return """
            select
              prefetch, hit, skip_init, skip_new, skip_fpw, skip_rep,
              stats_reset, wal_distance, block_distance, io_depth
            from pg_stat_recovery_prefetch
            """;
    }

    /**
     * pg_stat_user_functions. Tum versiyonlarda mevcut ama track_functions
     * ayari 'none' degilse dolar. dbid bagimli — hedef DB'de sorgulanir.
     */
    default String userFunctionsQuery() {
        return """
            select
              (select oid from pg_database where datname = current_database())::bigint as dbid,
              funcid::bigint as funcid,
              schemaname,
              funcname,
              calls,
              total_time,
              self_time
            from pg_stat_user_functions
            """;
    }

    // =========================================================================
    // Activity / Replication / Lock / Progress
    // =========================================================================

    /** pg_stat_activity — tum surumlerde mevcut. */
    String activityQuery();

    /** pg_stat_replication — tum surumlerde mevcut. */
    String replicationQuery();

    /** pg_locks — bekleyen lock'lar (granted = false). */
    String lockQuery();

    /** pg_stat_progress_vacuum — PG9.6+. */
    String progressVacuumQuery();

    /** pg_stat_progress_analyze — PG13+. */
    default String progressAnalyzeQuery() { return null; }

    /** pg_stat_progress_create_index — PG12+. */
    default String progressCreateIndexQuery() { return null; }

    // =========================================================================
    // Statements (pg_stat_statements)
    // =========================================================================

    /** pg_stat_statements(false) — yalnizca sayisal kolonlar (text yok). */
    String pgssStatsQuery();

    /** pg_stat_statements(true) — SQL text dahil (enrichment icin). */
    String pgssTextQuery();

    // =========================================================================
    // Per-database istatistikler
    // =========================================================================

    /** pg_stat_database — tum surumlerde mevcut. */
    String databaseStatsQuery();

    /** pg_stat_user_tables + pg_statio_user_tables. */
    String tableStatsQuery();

    /** pg_stat_user_indexes + pg_statio_user_indexes. */
    String indexStatsQuery();
}
