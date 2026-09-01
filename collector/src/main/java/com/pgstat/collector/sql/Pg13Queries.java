package com.pgstat.collector.sql;

/**
 * PG13 icin kaynak sorgulari.
 * pg11_12 uzerine eklenenler:
 * - plans / total_plan_time kolonlari (pg_stat_statements)
 * - wal_records, wal_fpi, wal_bytes (pg_stat_wal)
 * - pg_stat_progress_analyze
 *
 * Hala yok:
 * - toplevel kolonu (PG14+)
 * - jit_* kolonlari (PG15+)
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

    // pg_stat_wal PG14'te eklendi. PG13'te VIEW yok — null dondur ki collector
    // sorguyu atlasin (Pg11_12Queries.walQuery() de null doner, ayni davranis).
    // Pg14_16Queries.walQuery() override edip gercek sorgulamayi yapar.
    // walQuery() override silindi — superclass null doner.

    // =========================================================================
    // Activity — leader_pid eklendi (PG13+)
    // =========================================================================

    @Override
    public String activityQuery() {
        // PG13: leader_pid eklendi; query_id yok (PG14+)
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
              null::bigint as query_id
            from pg_stat_activity
            where pid <> pg_backend_pid()
            """;
    }

    // =========================================================================
    // Table stats — n_ins_since_vacuum eklendi (PG13+)
    // =========================================================================

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
              s.n_live_tup, s.n_dead_tup, s.n_mod_since_analyze,
              s.last_vacuum, s.last_autovacuum,
              s.last_analyze, s.last_autoanalyze,
              s.n_ins_since_vacuum,
              null::timestamptz as last_seq_scan,
              null::timestamptz as last_idx_scan,
              0::bigint as n_tup_newpage_upd,
              0::double precision as total_vacuum_time,
              0::double precision as total_autovacuum_time,
              0::double precision as total_analyze_time,
              0::double precision as total_autoanalyze_time,
              array_to_string(c.reloptions, ',') as reloptions_raw,
              -- Autovacuum'un KENDI esik hesabi reltuples'i kullanir,
              -- n_live_tup'u degil; ayrica katalogda durdugu icin istatistik
              -- sifirlamasini/restart'i atlatir (PGSTAT-P0-041).
              c.reltuples::bigint as reltuples,
              -- FIZIKSEL NESIL (PGSTAT-P0-046 Faz 2). pg_class join'i zaten
              -- vardi; uc kolon eklemenin ek maliyeti yok.
              --
              -- relfilenode: VACUUM FULL / CLUSTER tabloyu yeni bir dosyaya
              -- yazar ve bu deger degisir. relid (oid) degismez, yani kimlik
              -- korunur.
              --
              -- reltablespace: relfilenode ile BIRLIKTE bakilmali. SET
              -- TABLESPACE de filenode degistirir ama fork'lari blok blok
              -- kopyalar; sisme AYNEN KORUNUR. Sikistirma sayilmamali.
              --
              -- relpages: rewrite sonunda reltuples ile BIRLIKTE yazilir, yani
              -- tutarli bir cift. relpages * block_size / reltuples, tespit
              -- gecikmesinden bagimsiz olarak sikisik yogunlugu verir —
              -- pg_relation_size ise o arada buyumus olabilir.
              c.relfilenode::bigint as relfilenode,
              c.reltablespace::bigint as reltablespace,
              c.relpages::bigint as relpages,
              current_setting('block_size')::int as block_size
            from pg_stat_user_tables s
            left join pg_statio_user_tables io on io.relid = s.relid
            left join pg_class c on c.oid = s.relid
            """;
    }

    @Override
    public String progressAnalyzeQuery() {
        return """
            select
              p.pid, p.datid::bigint, d.datname, p.relid::bigint,
              p.phase,
              p.sample_blks_total, p.sample_blks_scanned,
              p.ext_stats_total, p.ext_stats_computed,
              p.child_tables_total, p.child_tables_done,
              p.current_child_table_relid::bigint
            from pg_stat_progress_analyze p
            left join pg_database d on d.oid = p.datid
            """;
    }

    /** PG13+: pg_stat_progress_basebackup. */
    @Override
    public String progressBasebackupQuery() {
        return """
            select
              pid, phase,
              backup_total, backup_streamed,
              tablespaces_total, tablespaces_streamed
            from pg_stat_progress_basebackup
            """;
    }

    // =========================================================================
    // Statements - plans ve wal eklendi
    // =========================================================================

    @Override
    public String pgssStatsQuery(String pgssFunction) {
        // PG13: plans, wal, min/max/stddev exec+plan, mean_exec/plan var; jit detay+temp_blk yok
        return """
            select
              userid, dbid, queryid,
              null::boolean as toplevel,
              calls,
              plans,
              total_plan_time,
              total_exec_time,
              min_exec_time, max_exec_time, stddev_exec_time,
              min_plan_time, max_plan_time, stddev_plan_time,
              mean_exec_time,
              mean_plan_time,
              rows,
              shared_blks_hit, shared_blks_read,
              shared_blks_dirtied, shared_blks_written,
              local_blks_hit, local_blks_read,
              local_blks_dirtied, local_blks_written,
              temp_blks_read, temp_blks_written,
              blk_read_time, blk_write_time,
              0::double precision as temp_blk_read_time,
              0::double precision as temp_blk_write_time,
              wal_records, wal_fpi, wal_bytes,
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

    // =========================================================================
    // Per-database — session_time/active_time yok (PG14+)
    // =========================================================================

    // databaseStatsQuery() → Pg11_12 kalitim ile ayni

    /** PG13+: pg_stat_slru mevcut — Pg11_12'nin null override'ini geri al. */
    @Override
    public String slruQuery() {
        return """
            select
              name, blks_zeroed, blks_hit, blks_read, blks_written,
              blks_exists, flushes, truncates, stats_reset
            from pg_stat_slru
            """;
    }

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
