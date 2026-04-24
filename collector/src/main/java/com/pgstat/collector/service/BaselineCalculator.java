package com.pgstat.collector.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Map;

/**
 * Adaptive alerting icin baseline profillerini hesaplar.
 *
 * Her aktif instance icin:
 *  - Son 28 gunluk veriyi fact.* tablolarindan ceker.
 *  - Her metrik icin:
 *      * Genel baseline (hour_of_day = -1): tum saatler
 *      * Saatlik baseline (hour_of_day = 0..23): saatlik pattern
 *  - avg/stddev/min/max/p50/p95/p99 hesaplar.
 *  - control.metric_baseline tablosuna UPSERT.
 *
 * JobOrchestrator tarafindan advisory lock altinda gunde bir kez cagrilir.
 */
@Service
public class BaselineCalculator {

    private static final Logger log = LoggerFactory.getLogger(BaselineCalculator.class);
    private static final String BASELINE_WINDOW = "28 days";

    private final JdbcTemplate jdbc;

    public BaselineCalculator(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Tum aktif instance'lar icin baseline'lari hesaplar.
     * JobOrchestrator advisory lock altinda cagirir (gunde bir kez).
     */
    public void calculateAll() {
        List<Map<String, Object>> instances = jdbc.queryForList(
            "select instance_pk from control.instance_inventory where is_active = true");

        if (instances.isEmpty()) {
            log.debug("Baseline hesaplamasi icin aktif instance yok");
            return;
        }

        log.info("Baseline hesaplamasi basliyor: {} instance", instances.size());
        int ok = 0, fail = 0;

        for (Map<String, Object> row : instances) {
            long instancePk = ((Number) row.get("instance_pk")).longValue();
            try {
                calculateForInstance(instancePk);
                ok++;
            } catch (Exception e) {
                log.error("Baseline hesaplama hatasi instance={}: {}", instancePk, e.getMessage());
                fail++;
            }
        }

        log.info("Baseline hesaplamasi tamamlandi: {} basarili, {} hata", ok, fail);
    }

    /**
     * Tek instance icin tum metriklerin baseline'ini hesaplar.
     */
    public void calculateForInstance(long instancePk) {
        // Cluster metrikleri (metric_family/metric_name pattern)
        calculateClusterMetric(instancePk, "bgwriter", "buffers_checkpoint",     "cluster.buffers_checkpoint");
        calculateClusterMetric(instancePk, "bgwriter", "buffers_clean",          "cluster.buffers_clean");
        calculateClusterMetric(instancePk, "wal",      "wal_bytes",              "cluster.wal_bytes");
        calculateClusterMetric(instancePk, "checkpointer", "checkpoints_timed",  "cluster.checkpoints_timed");
        calculateClusterMetric(instancePk, "checkpointer", "checkpoint_write_time", "cluster.checkpoint_write_time");

        // Database metrikleri (kolon-based)
        calculateDatabaseMetric(instancePk, "deadlocks_delta",    "database.deadlocks");
        calculateDatabaseMetric(instancePk, "temp_files_delta",   "database.temp_files");
        calculateDatabaseMetric(instancePk, "blk_read_time_delta","database.blk_read_time");
        calculateDatabaseMetric(instancePk, "db_size_bytes",      "database.db_size_bytes");

        // Derived database metrikleri
        calculateCacheHitRatio(instancePk);
        calculateRollbackRatio(instancePk);

        // Activity metrikleri (count bazli)
        calculateActivityCount(instancePk, "a.state = 'active'",              "activity.active_count");
        calculateActivityCount(instancePk, "a.state = 'idle in transaction'", "activity.idle_in_transaction_count");
        calculateActivityCount(instancePk, "a.wait_event_type is not null",  "activity.waiting_count");

        // Replication metrikleri
        calculateReplicationMetric(instancePk, "replay_lag_bytes",                       "replication.replay_lag_bytes");
        calculateReplicationMetric(instancePk, "extract(epoch from replay_lag)::numeric","replication.replay_lag_seconds");

        // Statement metrikleri
        calculateStatementMetric(instancePk, "calls_delta",             "statement.calls");
        calculateStatementMetric(instancePk, "temp_blks_written_delta", "statement.temp_blks_written");
        calculateStatementAvgExecTime(instancePk);

        log.debug("Baseline tamamlandi instance={}", instancePk);
    }

    // ========================================================================
    // Cluster metrik (metric_family/metric_name pattern)
    // ========================================================================

    private void calculateClusterMetric(long instancePk, String family, String name, String metricKey) {
        String sourceSql =
            "select sample_ts as ts, metric_value_num as val " +
            "from fact.pg_cluster_delta " +
            "where instance_pk = ? and metric_family = ? and metric_name = ? " +
            "  and sample_ts >= now() - interval '" + BASELINE_WINDOW + "'";

        upsertBaseline(instancePk, metricKey, sourceSql, new Object[]{instancePk, family, name});
    }

    // ========================================================================
    // Database metrik (kolon-bazli)
    // ========================================================================

    private void calculateDatabaseMetric(long instancePk, String column, String metricKey) {
        String safeCol = sanitize(column);
        String sourceSql =
            "select sample_ts as ts, " + safeCol + "::numeric as val " +
            "from fact.pg_database_delta " +
            "where instance_pk = ? " +
            "  and sample_ts >= now() - interval '" + BASELINE_WINDOW + "'";

        upsertBaseline(instancePk, metricKey, sourceSql, new Object[]{instancePk});
    }

    private void calculateCacheHitRatio(long instancePk) {
        // Saatlik bucket'lara gore hesaplanan ratio
        String sourceSql =
            "select date_trunc('hour', sample_ts) as ts, " +
            "       100.0 * sum(blks_hit_delta)::numeric / nullif(sum(blks_hit_delta + blks_read_delta), 0) as val " +
            "from fact.pg_database_delta " +
            "where instance_pk = ? " +
            "  and sample_ts >= now() - interval '" + BASELINE_WINDOW + "' " +
            "group by date_trunc('hour', sample_ts) " +
            "having sum(blks_hit_delta + blks_read_delta) > 0";

        upsertBaseline(instancePk, "database.cache_hit_ratio", sourceSql, new Object[]{instancePk});
    }

    private void calculateRollbackRatio(long instancePk) {
        String sourceSql =
            "select date_trunc('hour', sample_ts) as ts, " +
            "       100.0 * sum(xact_rollback_delta)::numeric / nullif(sum(xact_commit_delta + xact_rollback_delta), 0) as val " +
            "from fact.pg_database_delta " +
            "where instance_pk = ? " +
            "  and sample_ts >= now() - interval '" + BASELINE_WINDOW + "' " +
            "group by date_trunc('hour', sample_ts) " +
            "having sum(xact_commit_delta + xact_rollback_delta) > 0";

        upsertBaseline(instancePk, "database.rollback_ratio", sourceSql, new Object[]{instancePk});
    }

    // ========================================================================
    // Activity (snapshot bazli, her snapshot_ts icin count)
    // ========================================================================

    private void calculateActivityCount(long instancePk, String filter, String metricKey) {
        String sourceSql =
            "select snapshot_ts as ts, count(*)::numeric as val " +
            "from fact.pg_activity_snapshot a " +
            "where instance_pk = ? " +
            "  and snapshot_ts >= now() - interval '" + BASELINE_WINDOW + "' " +
            "  and " + filter + " " +
            "group by snapshot_ts";

        upsertBaseline(instancePk, metricKey, sourceSql, new Object[]{instancePk});
    }

    // ========================================================================
    // Replication
    // ========================================================================

    private void calculateReplicationMetric(long instancePk, String expr, String metricKey) {
        String sourceSql =
            "select snapshot_ts as ts, (" + expr + ")::numeric as val " +
            "from fact.pg_replication_snapshot " +
            "where instance_pk = ? " +
            "  and snapshot_ts >= now() - interval '" + BASELINE_WINDOW + "'";

        upsertBaseline(instancePk, metricKey, sourceSql, new Object[]{instancePk});
    }

    // ========================================================================
    // Statement (pgss_delta)
    // ========================================================================

    private void calculateStatementMetric(long instancePk, String column, String metricKey) {
        String safeCol = sanitize(column);
        // Saatlik toplama (ayri query'ler degil, instance-level aggregate)
        String sourceSql =
            "select date_trunc('hour', sample_ts) as ts, sum(" + safeCol + ")::numeric as val " +
            "from fact.pgss_delta " +
            "where instance_pk = ? " +
            "  and sample_ts >= now() - interval '" + BASELINE_WINDOW + "' " +
            "group by date_trunc('hour', sample_ts)";

        upsertBaseline(instancePk, metricKey, sourceSql, new Object[]{instancePk});
    }

    private void calculateStatementAvgExecTime(long instancePk) {
        String sourceSql =
            "select date_trunc('hour', sample_ts) as ts, " +
            "       sum(total_exec_time_delta)::numeric / nullif(sum(calls_delta), 0) as val " +
            "from fact.pgss_delta " +
            "where instance_pk = ? " +
            "  and sample_ts >= now() - interval '" + BASELINE_WINDOW + "' " +
            "group by date_trunc('hour', sample_ts) " +
            "having sum(calls_delta) > 0";

        upsertBaseline(instancePk, "statement.avg_exec_time_ms", sourceSql, new Object[]{instancePk});
    }

    // ========================================================================
    // UPSERT: genel + saatlik baseline tek seferde yazilir
    // ========================================================================

    /**
     * sourceSql yapisal olarak: (ts timestamptz, val numeric) donduren bir sorgu.
     * Bu fonksiyon bu CTE'yi alip hem genel (-1) hem saatlik (0..23) baseline'lari
     * control.metric_baseline tablosuna yazar.
     */
    private void upsertBaseline(long instancePk, String metricKey, String sourceSql, Object[] args) {
        String sql =
            "with src as (" + sourceSql + "), " +
            "filtered as (select * from src where val is not null) " +
            "insert into control.metric_baseline " +
            "  (instance_pk, metric_key, hour_of_day, " +
            "   avg_value, stddev_value, min_value, max_value, " +
            "   p50_value, p95_value, p99_value, sample_count, " +
            "   baseline_start, baseline_end, updated_at) " +
            // Genel (-1)
            "select ?, ?, -1, " +
            "       avg(val), stddev_samp(val), min(val), max(val), " +
            "       percentile_cont(0.50) within group (order by val), " +
            "       percentile_cont(0.95) within group (order by val), " +
            "       percentile_cont(0.99) within group (order by val), " +
            "       count(*)::int, now() - interval '" + BASELINE_WINDOW + "', now(), now() " +
            "from filtered " +
            "having count(*) > 0 " +
            "union all " +
            // Saatlik (0..23)
            "select ?, ?, extract(hour from ts)::int, " +
            "       avg(val), stddev_samp(val), min(val), max(val), " +
            "       percentile_cont(0.50) within group (order by val), " +
            "       percentile_cont(0.95) within group (order by val), " +
            "       percentile_cont(0.99) within group (order by val), " +
            "       count(*)::int, now() - interval '" + BASELINE_WINDOW + "', now(), now() " +
            "from filtered " +
            "group by extract(hour from ts) " +
            "having count(*) > 0 " +
            "on conflict (instance_pk, metric_key, hour_of_day) do update set " +
            "  avg_value      = excluded.avg_value, " +
            "  stddev_value   = excluded.stddev_value, " +
            "  min_value      = excluded.min_value, " +
            "  max_value      = excluded.max_value, " +
            "  p50_value      = excluded.p50_value, " +
            "  p95_value      = excluded.p95_value, " +
            "  p99_value      = excluded.p99_value, " +
            "  sample_count   = excluded.sample_count, " +
            "  baseline_start = excluded.baseline_start, " +
            "  baseline_end   = excluded.baseline_end, " +
            "  updated_at     = now()";

        Object[] full = new Object[args.length + 4];
        System.arraycopy(args, 0, full, 0, args.length);
        full[args.length]     = instancePk;
        full[args.length + 1] = metricKey;
        full[args.length + 2] = instancePk;
        full[args.length + 3] = metricKey;

        try {
            jdbc.update(sql, full);
        } catch (Exception e) {
            log.debug("Baseline upsert hatasi metric={} instance={}: {}", metricKey, instancePk, e.getMessage());
        }
    }

    private String sanitize(String col) {
        if (col == null || !col.matches("[a-z_][a-z0-9_]*"))
            throw new IllegalArgumentException("Gecersiz kolon adi: " + col);
        return col;
    }
}
