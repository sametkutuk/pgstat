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
