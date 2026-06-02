package com.pgstat.collector.repository;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * agg sema tablolari icin rollup islemleri.
 * pgss_hourly ve pgss_daily toplama sorgulari.
 * Mimari dok: satir 3593-3630, 1336-1367
 */
@Repository
public class AggRepository {

    private final JdbcTemplate jdbc;

    public AggRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Saatlik rollup — son tamamlanan saat bucket'i icin pgss_delta → pgss_hourly.
     * ON CONFLICT ile idempotent; tekrar calistirilirsa uzerine yazar.
     *
     * @return yazilan satir sayisi
     */
    public int rollupHourly() {
        return jdbc.update("""
            insert into agg.pgss_hourly (
              bucket_start,
              instance_pk,
              statement_series_id,
              calls_sum,
              exec_time_ms_sum,
              rows_sum,
              shared_blks_read_sum,
              shared_blks_hit_sum,
              temp_blks_written_sum
            )
            select
              date_trunc('hour', sample_ts)   as bucket_start,
              instance_pk,
              statement_series_id,
              sum(calls_delta)                as calls_sum,
              sum(total_exec_time_ms_delta)   as exec_time_ms_sum,
              sum(rows_delta)                 as rows_sum,
              sum(shared_blks_read_delta)     as shared_blks_read_sum,
              sum(shared_blks_hit_delta)      as shared_blks_hit_sum,
              sum(temp_blks_written_delta)    as temp_blks_written_sum
            from fact.pgss_delta
            where sample_ts >= date_trunc('hour', now() - interval '1 hour')
              and sample_ts <  date_trunc('hour', now())
            group by date_trunc('hour', sample_ts), instance_pk, statement_series_id
            on conflict (bucket_start, instance_pk, statement_series_id) do update
              set calls_sum             = excluded.calls_sum,
                  exec_time_ms_sum      = excluded.exec_time_ms_sum,
                  rows_sum              = excluded.rows_sum,
                  shared_blks_read_sum  = excluded.shared_blks_read_sum,
                  shared_blks_hit_sum   = excluded.shared_blks_hit_sum,
                  temp_blks_written_sum = excluded.temp_blks_written_sum
            """);
    }

    /**
     * Saatlik rollup: pg_table_stat_delta -> pg_table_stat_hourly.
     * ON CONFLICT ile idempotent.
     *
     * @return yazilan satir sayisi
     */
    public int rollupTableStatHourly() {
        return jdbc.update("""
            insert into agg.pg_table_stat_hourly (
              bucket_start,
              instance_pk,
              dbid,
              relid,
              schemaname,
              relname,
              n_tup_ins_sum,
              n_tup_upd_sum,
              n_tup_del_sum,
              n_tup_hot_upd_sum,
              vacuum_count_sum,
              autovacuum_count_sum,
              analyze_count_sum,
              autoanalyze_count_sum,
              seq_scan_sum,
              idx_scan_sum,
              n_live_tup_last,
              n_dead_tup_last,
              n_mod_since_analyze_last,
              last_vacuum,
              last_autovacuum,
              last_analyze,
              last_autoanalyze
            )
            select
              date_trunc('hour', sample_ts) as bucket_start,
              instance_pk,
              dbid,
              relid,
              schemaname,
              relname,
              sum(coalesce(n_tup_ins_delta, 0)) as n_tup_ins_sum,
              sum(coalesce(n_tup_upd_delta, 0)) as n_tup_upd_sum,
              sum(coalesce(n_tup_del_delta, 0)) as n_tup_del_sum,
              sum(coalesce(n_tup_hot_upd_delta, 0)) as n_tup_hot_upd_sum,
              sum(coalesce(vacuum_count_delta, 0)) as vacuum_count_sum,
              sum(coalesce(autovacuum_count_delta, 0)) as autovacuum_count_sum,
              sum(coalesce(analyze_count_delta, 0)) as analyze_count_sum,
              sum(coalesce(autoanalyze_count_delta, 0)) as autoanalyze_count_sum,
              sum(coalesce(seq_scan_delta, 0)) as seq_scan_sum,
              sum(coalesce(idx_scan_delta, 0)) as idx_scan_sum,
              (array_agg(n_live_tup_estimate order by sample_ts desc))[1] as n_live_tup_last,
              (array_agg(n_dead_tup_estimate order by sample_ts desc))[1] as n_dead_tup_last,
              (array_agg(n_mod_since_analyze order by sample_ts desc))[1] as n_mod_since_analyze_last,
              max(last_vacuum) as last_vacuum,
              max(last_autovacuum) as last_autovacuum,
              max(last_analyze) as last_analyze,
              max(last_autoanalyze) as last_autoanalyze
            from fact.pg_table_stat_delta
            where sample_ts >= date_trunc('hour', now() - interval '1 hour')
              and sample_ts <  date_trunc('hour', now())
            group by date_trunc('hour', sample_ts), instance_pk, dbid, relid, schemaname, relname
            on conflict (bucket_start, instance_pk, dbid, relid) do update
              set n_tup_ins_sum = excluded.n_tup_ins_sum,
                  n_tup_upd_sum = excluded.n_tup_upd_sum,
                  n_tup_del_sum = excluded.n_tup_del_sum,
                  n_tup_hot_upd_sum = excluded.n_tup_hot_upd_sum,
                  vacuum_count_sum = excluded.vacuum_count_sum,
                  autovacuum_count_sum = excluded.autovacuum_count_sum,
                  analyze_count_sum = excluded.analyze_count_sum,
                  autoanalyze_count_sum = excluded.autoanalyze_count_sum,
                  seq_scan_sum = excluded.seq_scan_sum,
                  idx_scan_sum = excluded.idx_scan_sum,
                  n_live_tup_last = excluded.n_live_tup_last,
                  n_dead_tup_last = excluded.n_dead_tup_last,
                  n_mod_since_analyze_last = excluded.n_mod_since_analyze_last,
                  last_vacuum = excluded.last_vacuum,
                  last_autovacuum = excluded.last_autovacuum,
                  last_analyze = excluded.last_analyze,
                  last_autoanalyze = excluded.last_autoanalyze
            """);
    }

    /**
     * Gunluk rollup: dunku gun icin pgss_hourly -> pgss_daily.
     * ON CONFLICT ile idempotent.
     *
     * @return yazilan satir sayisi
     */
    public int rollupDaily() {
        return jdbc.update("""
            insert into agg.pgss_daily (
              bucket_start,
              instance_pk,
              statement_series_id,
              calls_sum,
              exec_time_ms_sum,
              rows_sum,
              shared_blks_read_sum,
              shared_blks_hit_sum,
              temp_blks_written_sum
            )
            select
              ((now() at time zone 'UTC')::date - 1)::timestamptz as bucket_start,
              instance_pk,
              statement_series_id,
              sum(calls_sum)            as calls_sum,
              sum(exec_time_ms_sum)     as exec_time_ms_sum,
              sum(rows_sum)             as rows_sum,
              sum(shared_blks_read_sum) as shared_blks_read_sum,
              sum(shared_blks_hit_sum)  as shared_blks_hit_sum,
              sum(temp_blks_written_sum) as temp_blks_written_sum
            from agg.pgss_hourly
            where bucket_start >= ((now() at time zone 'UTC')::date - 1)::timestamptz
              and bucket_start <  ((now() at time zone 'UTC')::date)::timestamptz
            group by instance_pk, statement_series_id
            on conflict (bucket_start, instance_pk, statement_series_id) do update
              set calls_sum             = excluded.calls_sum,
                  exec_time_ms_sum      = excluded.exec_time_ms_sum,
                  rows_sum              = excluded.rows_sum,
                  shared_blks_read_sum  = excluded.shared_blks_read_sum,
                  shared_blks_hit_sum   = excluded.shared_blks_hit_sum,
                  temp_blks_written_sum = excluded.temp_blks_written_sum
            """);
    }
}
