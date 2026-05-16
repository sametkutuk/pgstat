package com.pgstat.collector.sql;

/**
 * Kaynak PostgreSQL'de calistirilacak SQL sorgulari arayuzu.
 * Her SQL family (pg11_12, pg13, pg14_16, pg17_18) farkli implementasyon sunar.
 *
 * Farklar:
 * - pg11_12: toplevel yok, plans yok, wal/jit kolonu yok, waitstart yok
 * - pg13: plans, total_plan_time, wal_records/bytes eklenir; toplevel ve jit_* yok
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

    /** pg_stat_statements_info destegi (PG14+). */
    default boolean supportsPgssInfo() { return false; }

    /** pg_stat_statements_info (PG14+; eski surumlerde null doner). */
    default String pgssInfoQuery(String pgssInfoRelation) { return null; }

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
        // PG14+ default: pg_replication_slots + pg_stat_replication_slots join
        // PG17+ slot health kolonlari to_jsonb safe-lookup ile
        return """
            with src as (
              select to_jsonb(s.*) as j, s.* from pg_replication_slots s
            )
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
              sr.total_txns, sr.total_bytes,
              sr.stats_reset,
              coalesce((src.j->>'temporary')::boolean, false) as temporary,
              coalesce((src.j->>'two_phase')::boolean, false) as two_phase,
              (src.j->>'conflicting')::boolean as conflicting,
              src.j->>'invalidation_reason' as invalidation_reason,
              coalesce((src.j->>'failover')::boolean, false) as failover,
              coalesce((src.j->>'synced')::boolean, false) as synced
            from pg_replication_slots s
            join src on src.slot_name = s.slot_name
            left join pg_stat_replication_slots sr on sr.slot_name = s.slot_name
            """;
    }

    /** pg_stat_database_conflicts (PG9.1+). */
    default String databaseConflictsQuery() {
        // PG16+: confl_active_logicalslot eklendi — to_jsonb safe-lookup
        return """
            with src as (
              select to_jsonb(c.*) as j, c.* from pg_stat_database_conflicts c
              where c.datname is not null
            )
            select
              datid::bigint as datid,
              datname,
              confl_tablespace,
              confl_lock,
              confl_snapshot,
              confl_bufferpin,
              confl_deadlock,
              coalesce((j->>'confl_active_logicalslot')::bigint, 0) as confl_active_logicalslot
            from src
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
        // PG15+ default: pg_stat_subscription + pg_stat_subscription_stats join
        // PG18+: worker_type, 7 conflict kolonlari to_jsonb safe-lookup
        return """
            with sub_src as (
              select to_jsonb(s.*) as j, s.* from pg_stat_subscription s
            ),
            stats_src as (
              select to_jsonb(ss.*) as j, ss.* from pg_stat_subscription_stats ss
            )
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
              ss.stats_reset,
              coalesce(sub_src.j->>'leader_pid', null)::integer as leader_pid,
              coalesce(sub_src.j->>'worker_type', 'apply') as worker_type,
              coalesce((stats_src.j->>'confl_insert_exists')::bigint, 0) as confl_insert_exists,
              coalesce((stats_src.j->>'confl_update_origin_differs')::bigint, 0) as confl_update_origin_differs,
              coalesce((stats_src.j->>'confl_update_exists')::bigint, 0) as confl_update_exists,
              coalesce((stats_src.j->>'confl_update_missing')::bigint, 0) as confl_update_missing,
              coalesce((stats_src.j->>'confl_delete_origin_differs')::bigint, 0) as confl_delete_origin_differs,
              coalesce((stats_src.j->>'confl_delete_missing')::bigint, 0) as confl_delete_missing,
              coalesce((stats_src.j->>'confl_multiple_unique_conflicts')::bigint, 0) as confl_multiple_unique_conflicts
            from pg_stat_subscription s
            join sub_src on sub_src.subid = s.subid
            left join pg_stat_subscription_stats ss on ss.subid = s.subid
            left join stats_src on stats_src.subid = s.subid
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

    /**
     * pg_statio_all_sequences — sequence I/O istatistikleri.
     * Tum versiyonlarda mevcut. dbid bagimli — hedef DB'de sorgulanir.
     */
    default String sequenceIoQuery() {
        return """
            select
              (select oid from pg_database where datname = current_database())::bigint as dbid,
              relid::bigint as relid,
              schemaname,
              relname,
              blks_read,
              blks_hit
            from pg_statio_all_sequences
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

    /** pg_stat_progress_vacuum — full kolonlar (Madde 8). PG version-safe. */
    default String progressVacuumFullQuery() {
        // to_jsonb safe-lookup ile PG14+ ve PG17+ kolonlari
        // Not: pg_stat_progress_vacuum zaten datname iceriyor; pg_database join'ine gerek yok
        return """
            with src as (
              select to_jsonb(p.*) as j, p.*
              from pg_stat_progress_vacuum p
            )
            select
              pid, datid::bigint, datname, relid::bigint, phase,
              heap_blks_total, heap_blks_scanned, heap_blks_vacuumed,
              coalesce((j->>'index_vacuum_count')::bigint, 0) as index_vacuum_count,
              coalesce((j->>'max_dead_item_ids')::bigint,
                       (j->>'max_dead_tuples')::bigint, 0) as max_dead_item_ids,
              coalesce((j->>'max_dead_tuple_bytes')::bigint, 0) as max_dead_tuple_bytes,
              coalesce((j->>'num_dead_item_ids')::bigint,
                       (j->>'num_dead_tuples')::bigint, 0) as num_dead_item_ids,
              coalesce((j->>'dead_tuple_bytes')::bigint, 0) as dead_tuple_bytes,
              coalesce((j->>'indexes_total')::bigint, 0) as indexes_total,
              coalesce((j->>'indexes_processed')::bigint, 0) as indexes_processed
            from src
            """;
    }

    /** pg_stat_progress_analyze — PG13+. */
    default String progressAnalyzeQuery() { return null; }

    /** pg_stat_progress_create_index — PG12+. */
    default String progressCreateIndexQuery() { return null; }

    /** pg_stat_progress_basebackup — PG13+ (primary only). */
    default String progressBasebackupQuery() { return null; }

    /** pg_stat_progress_copy — PG14+. */
    default String progressCopyQuery() { return null; }

    /** pg_stat_progress_cluster — PG12+ (CLUSTER/VACUUM FULL). */
    default String progressClusterQuery() { return null; }

    /** pg_stat_wal_receiver — PG9.6+ (standby only). Null doner primary'de. */
    default String walReceiverQuery() {
        // PG13+ full set: written_lsn var, sender_host/port var
        return """
            with src as (
              select to_jsonb(r.*) as j, r.* from pg_stat_wal_receiver r
            )
            select
              pid, status,
              receive_start_lsn::text as receive_start_lsn,
              receive_start_tli,
              coalesce((j->>'written_lsn'), flushed_lsn::text) as written_lsn,
              flushed_lsn::text as flushed_lsn,
              received_tli,
              last_msg_send_time,
              last_msg_receipt_time,
              latest_end_lsn::text as latest_end_lsn,
              latest_end_time,
              slot_name,
              coalesce(j->>'sender_host', '') as sender_host,
              coalesce((j->>'sender_port')::integer, 0) as sender_port,
              case when flushed_lsn is not null
                then pg_wal_lsn_diff(pg_last_wal_receive_lsn(), flushed_lsn)::bigint
                else null end as lag_bytes
            from src
            """;
    }

    // =========================================================================
    // Statements (pg_stat_statements)
    // =========================================================================

    /** pg_stat_statements(false) — yalnizca sayisal kolonlar (text yok). */
    String pgssStatsQuery(String pgssFunction);

    /** pg_stat_statements(true) — SQL text dahil (enrichment icin). */
    String pgssTextQuery(String pgssFunction);

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
