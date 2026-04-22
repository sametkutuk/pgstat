package com.pgstat.collector.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Retention enforcement — partition drop ve instance bazli batched delete.
 *
 * Calisma mantigi (mimari dok'tan):
 *  1. Her instance'in raw_retention_months'una gore cutoff hesapla
 *  2. En uzun retention'a sahip instance'in cutoff'unu bul (global hard drop siniri)
 *  3. Hard drop sinirinin gerisindeki fact partisyonlarini drop et
 *  4. Hard drop ile instance bazli cutoff arasinda kalan partisyonlarda
 *     sadece ilgili instance_pk satirlarini batched delete ile sil
 *  5. Ayni mantik agg tablolari icin (hourly/daily retention)
 *  6. ops tablolari icin 90 gunluk sabit retention
 */
@Component
public class PurgeEvaluator {

    private static final Logger log = LoggerFactory.getLogger(PurgeEvaluator.class);

    /** Batched delete limiti — tek seferde silinecek maksimum satir */
    private static final int DELETE_BATCH_SIZE = 10_000;

    /** ops tablolari icin sabit retention (gun) */
    private static final int OPS_RETENTION_DAYS = 90;

    /** Gunluk partition gerektiren fact tablolari */
    private static final String[] DAILY_FACT_TABLES = {
        "fact.pgss_delta",
        "fact.pg_database_delta",
        "fact.pg_table_stat_delta",
        "fact.pg_index_stat_delta",
        "fact.pg_cluster_delta",
        "fact.pg_io_stat_delta"
    };

    /** snapshot_ts kullanan tablolar (sample_ts degil) */
    private static final String[] SNAPSHOT_FACT_TABLES = {
        "fact.pg_activity_snapshot",
        "fact.pg_replication_snapshot",
        "fact.pg_lock_snapshot",
        "fact.pg_progress_snapshot"
    };

    private final JdbcTemplate jdbc;

    public PurgeEvaluator(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Retention kurallarini degerlendirir ve eski veriyi temizler.
     * Rollup job tarafindan gunluk olarak cagirilir.
     */
    public void evaluate() {
        purgeRawFacts();
        purgeHourlyAgg();
        purgeDailyAgg();
        purgeOps();
    }

    // =========================================================================
    // Raw fact tablolari purge
    // =========================================================================

    private void purgeRawFacts() {
        // 1. Instance bazli retention cutoff'lari
        List<Map<String, Object>> instanceCutoffs = jdbc.queryForList("""
            select
              i.instance_pk,
              date_trunc('month', now()) - make_interval(months => p.raw_retention_months) as raw_keep_from
            from control.instance_inventory i
            join control.retention_policy p on p.retention_policy_id = i.retention_policy_id
            where i.is_active and p.is_active and p.purge_enabled
            """);

        if (instanceCutoffs.isEmpty()) return;

        // 2. Global hard drop siniri (en uzun retention)
        LocalDate hardDropBefore = jdbc.queryForObject("""
            select (date_trunc('month', now()) - make_interval(months => max(p.raw_retention_months)))::date
            from control.retention_policy p
            where p.is_active and p.purge_enabled
            """,
            LocalDate.class
        );

        if (hardDropBefore == null) return;

        log.info("Raw fact purge: hard drop siniri = {}", hardDropBefore);

        // 3. Hard drop sinirinin gerisindeki partisyonlari drop et
        for (String parentTable : DAILY_FACT_TABLES) {
            dropPartitionsBefore(parentTable, hardDropBefore);
        }
        for (String parentTable : SNAPSHOT_FACT_TABLES) {
            dropPartitionsBefore(parentTable, hardDropBefore);
        }

        // 4. Instance bazli batched delete (tier farki olan instance'lar icin)
        for (Map<String, Object> row : instanceCutoffs) {
            long instancePk = ((Number) row.get("instance_pk")).longValue();
            java.sql.Timestamp keepFrom = (java.sql.Timestamp) row.get("raw_keep_from");
            LocalDate instanceKeepFrom = keepFrom.toLocalDateTime().toLocalDate();

            if (instanceKeepFrom.isAfter(hardDropBefore)) {
                for (String parentTable : DAILY_FACT_TABLES) {
                    batchedDeleteForInstance(parentTable, "sample_ts", instancePk,
                        hardDropBefore, instanceKeepFrom);
                }
                for (String parentTable : SNAPSHOT_FACT_TABLES) {
                    batchedDeleteForInstance(parentTable, "snapshot_ts", instancePk,
                        hardDropBefore, instanceKeepFrom);
                }
            }
        }
    }

    // =========================================================================
    // agg.pgss_hourly purge (monthly partition drop)
    // =========================================================================

    private void purgeHourlyAgg() {
        LocalDate hourlyDropBefore = jdbc.queryForObject("""
            select (date_trunc('month', now()) - make_interval(months => max(p.hourly_retention_months)))::date
            from control.retention_policy p
            where p.is_active and p.purge_enabled
            """,
            LocalDate.class
        );

        if (hourlyDropBefore == null) return;

        log.info("Hourly agg purge: drop siniri = {}", hourlyDropBefore);
        dropPartitionsBefore("agg.pgss_hourly", hourlyDropBefore);
    }

    // =========================================================================
    // agg.pgss_daily purge (yearly partition drop)
    // =========================================================================

    private void purgeDailyAgg() {
        LocalDate dailyDropBefore = jdbc.queryForObject("""
            select (date_trunc('month', now()) - make_interval(months => max(p.daily_retention_months)))::date
            from control.retention_policy p
            where p.is_active and p.purge_enabled
            """,
            LocalDate.class
        );

        if (dailyDropBefore == null) return;

        log.info("Daily agg purge: drop siniri = {}", dailyDropBefore);
        dropPartitionsBefore("agg.pgss_daily", dailyDropBefore);
    }

    // =========================================================================
    // ops tablolari purge (90 gun sabit)
    // =========================================================================

    private void purgeOps() {
        // ops.job_run — cascade ile job_run_instance de silinir
        int deletedRuns = jdbc.update("""
            delete from ops.job_run
            where started_at < now() - interval '90 days'
            """);

        // ops.alert — resolved ve 90 gunden eski
        int deletedAlerts = jdbc.update("""
            delete from ops.alert
            where resolved_at is not null
              and resolved_at < now() - interval '90 days'
            """);

        if (deletedRuns > 0 || deletedAlerts > 0) {
            log.info("Ops purge: {} job_run, {} alert silindi", deletedRuns, deletedAlerts);
        }
    }

    // =========================================================================
    // Yardimci metotlar
    // =========================================================================

    /**
     * Belirtilen tarihten onceki partisyonlari DETACH + DROP eder.
     * Partition isimlerinden tarih bilgisini cikarir ve karsilastirir.
     */
    private void dropPartitionsBefore(String parentTable, LocalDate beforeDate) {
        String[] parts = parentTable.split("\\.", 2);
        String schema = parts[0];
        String table = parts[1];

        List<Map<String, Object>> partitions = jdbc.queryForList("""
            select
              nmsp.nspname || '.' || child.relname as full_name,
              child.relname as part_name,
              pg_get_expr(child.relpartbound, child.oid) as bounds
            from pg_inherits
            join pg_class parent on parent.oid = pg_inherits.inhparent
            join pg_class child  on child.oid  = pg_inherits.inhrelid
            join pg_namespace nmsp on nmsp.oid = child.relnamespace
            where parent.relname = ?
              and parent.relnamespace = (select oid from pg_namespace where nspname = ?)
            """,
            table, schema
        );

        for (Map<String, Object> partition : partitions) {
            String fullName = (String) partition.get("full_name");
            String bounds = (String) partition.get("bounds");

            // Bounds'tan baslangic tarihini cikar
            // Ornek: "FOR VALUES FROM ('2026-01-01') TO ('2026-01-02')"
            LocalDate partStart = extractStartDate(bounds);
            if (partStart == null) continue;

            if (partStart.isBefore(beforeDate)) {
                try {
                    jdbc.execute("ALTER TABLE " + parentTable + " DETACH PARTITION " + fullName);
                    jdbc.execute("DROP TABLE " + fullName);
                    log.info("Partition drop edildi: {}", fullName);
                } catch (Exception e) {
                    log.warn("Partition drop hatasi: {} — {}", fullName, e.getMessage());
                }
            }
        }
    }

    /** Partition bounds string'inden baslangic tarihini cikarir. */
    private LocalDate extractStartDate(String bounds) {
        if (bounds == null) return null;
        try {
            // "FOR VALUES FROM ('2026-01-01') TO ('2026-01-02')" formatindan parse
            int fromIdx = bounds.indexOf("'");
            int toIdx = bounds.indexOf("'", fromIdx + 1);
            if (fromIdx < 0 || toIdx < 0) return null;
            String dateStr = bounds.substring(fromIdx + 1, toIdx);
            // Sadece tarih kismini al (timestamp olabilir)
            if (dateStr.length() > 10) dateStr = dateStr.substring(0, 10);
            return LocalDate.parse(dateStr);
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Instance bazli batched delete — tier farki olan instance'lar icin.
     * Hard drop siniri ile instance cutoff arasindaki partisyonlarda
     * sadece ilgili instance_pk satirlarini siler.
     */
    private void batchedDeleteForInstance(String parentTable, String tsColumn,
                                          long instancePk,
                                          LocalDate fromDate, LocalDate toDate) {
        int totalDeleted = 0;
        int deleted;
        do {
            deleted = jdbc.update(
                "delete from " + parentTable +
                " where ctid in (" +
                "  select ctid from " + parentTable +
                "  where " + tsColumn + " >= ?::date" +
                "    and " + tsColumn + " < ?::date" +
                "    and instance_pk = ?" +
                "  limit ?" +
                ")",
                fromDate, toDate, instancePk, DELETE_BATCH_SIZE
            );
            totalDeleted += deleted;
        } while (deleted >= DELETE_BATCH_SIZE);

        if (totalDeleted > 0) {
            log.info("Batched delete: {} — instance_pk={}, {} satir silindi",
                parentTable, instancePk, totalDeleted);
        }
    }
}
