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
     * Gunluk rollup — dunku gun icin pgss_hourly → pgss_daily.
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
