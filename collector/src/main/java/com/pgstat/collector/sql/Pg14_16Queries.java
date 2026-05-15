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
    public String pgssStatsQuery(String pgssFunction) {
        // PG14-16: toplevel, plans, jit detay var.
        // PG15+ temp_blk_read/write_time, stats_since, minmax_stats_since
        // PG16+ jit_deform_count/time
        // Pragmatik: PG14'te temp_blk_*_time yok → coalesce ile 0
        // PG15-16'da doğrudan kolon var; SQL versiyona gore branch yapmak yerine
        // run-time'da try/catch yapamayız (single SQL). Bu yuzden:
        //   - PG14-15-16 hepsi icin pg_extension version'a bakmak yerine
        //   - to_jsonb ile kolon yoksa null donuyor mantigi kullanamıyoruz (subquery zorlasiyor)
        // Cozum: Bu sinif PG14-16 ortak. PG14 icin temp_blk_*_time yoktur → bu durumda
        // ext yuklu olsa bile pg_stat_statements 1.10 kolonu olmamasi durumunda
        // SQL hata verir. Ama yine de cogu PG14 1.10'a guncellenebiliyor.
        // En guvenli yol: to_jsonb -> obj #>> '{key}' okuma (column existence safe)
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
              (j->>'stats_since')::timestamptz          as stats_since,
              (j->>'minmax_stats_since')::timestamptz   as minmax_stats_since,
              0::bigint as parallel_workers_to_launch,
              0::bigint as parallel_workers_launched
            from src
            """.formatted(pgssFunction);
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
