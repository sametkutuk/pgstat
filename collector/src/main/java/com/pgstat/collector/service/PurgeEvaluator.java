package com.pgstat.collector.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;

/**
 * Retention enforcement — partition drop + instance bazli batched delete.
 *
 * Calisma mantigi:
 *  1. RAW fact tablolari icin:
 *     - Her instance'in raw_retention_days cutoff'unu bul
 *     - Global hard drop (en uzun retention) sinirinin gerisindeki partisyonlari DROP
 *     - Arada kalan aralikta instance bazli batched DELETE
 *  2. SNAPSHOT tablolari icin saat bazli retention (cok daha kisa)
 *  3. agg.pgss_hourly / agg.pgss_daily icin ay bazli partition drop
 *  4. ops tablolari icin sabit 90 gun
 */
@Component
public class PurgeEvaluator {

    private static final Logger log = LoggerFactory.getLogger(PurgeEvaluator.class);

    private static final int DELETE_BATCH_SIZE = 10_000;
    private static final int OPS_RETENTION_DAYS = 90;

    /** Ham delta tablolari — sample_ts kullanir, day-bazli partition */
    private static final String[] DELTA_FACT_TABLES = {
        "fact.pgss_delta",
        "fact.pg_database_delta",
        "fact.pg_table_stat_delta",
        "fact.pg_index_stat_delta",
        "fact.pg_cluster_delta",
        "fact.pg_io_stat_delta"
    };

    /** Snapshot tablolari — snapshot_ts/sample_ts kullanir, hacmi cok buyuk oldugu icin ayri retention */
    private static final String[] SNAPSHOT_FACT_TABLES = {
        "fact.pg_activity_snapshot",
        "fact.pg_replication_snapshot",
        "fact.pg_lock_snapshot",
        "fact.pg_progress_snapshot",
        "fact.pg_wal_snapshot",
        "fact.pg_archiver_snapshot",
        "fact.pg_replication_slot_snapshot",
        "fact.pg_database_conflict_snapshot",
        "fact.pg_slru_snapshot",
        "fact.pg_subscription_snapshot",
        "fact.pg_recovery_prefetch_snapshot",
        "fact.pg_user_function_snapshot",
        "fact.pg_sequence_io_snapshot"
    };

    private final JdbcTemplate jdbc;

    public PurgeEvaluator(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public void evaluate() {
        purgeRawDeltaFacts();
        purgeSnapshotFacts();
        purgeHourlyAgg();
        purgeDailyAgg();
        purgeOps();
    }

    // =========================================================================
    // RAW DELTA fact tablolari (day-bazli retention)
    // =========================================================================

    private void purgeRawDeltaFacts() {
        // Instance bazli cutoff (yeni gun-bazli kolon)
        List<Map<String, Object>> instanceCutoffs = jdbc.queryForList("""
            select
              i.instance_pk,
              (current_date - coalesce(p.raw_retention_days, p.raw_retention_months * 30))::date as keep_from
            from control.instance_inventory i
            join control.retention_policy p on p.retention_policy_id = i.retention_policy_id
            where i.is_active and p.is_active and p.purge_enabled
            """);

        if (instanceCutoffs.isEmpty()) return;

        // Hard drop siniri = en uzun retention
        LocalDate hardDropBefore = jdbc.queryForObject("""
            select (current_date - max(coalesce(p.raw_retention_days, p.raw_retention_months * 30)))::date
            from control.retention_policy p
            where p.is_active and p.purge_enabled
            """,
            LocalDate.class
        );
        if (hardDropBefore == null) return;

        log.info("Raw delta fact purge: hard drop siniri = {}", hardDropBefore);

        // Partition drop
        for (String table : DELTA_FACT_TABLES) {
            dropPartitionsBefore(table, hardDropBefore);
        }

        // Instance bazli batched delete (arada kalan aralikta)
        for (Map<String, Object> row : instanceCutoffs) {
            long instancePk = ((Number) row.get("instance_pk")).longValue();
            java.sql.Date keepFromSql = (java.sql.Date) row.get("keep_from");
            LocalDate instanceKeepFrom = keepFromSql.toLocalDate();

            if (instanceKeepFrom.isAfter(hardDropBefore)) {
                for (String table : DELTA_FACT_TABLES) {
                    batchedDeleteForInstance(table, "sample_ts", instancePk,
                        hardDropBefore, instanceKeepFrom);
                }
            }
        }
    }

    // =========================================================================
    // SNAPSHOT fact tablolari (saat-bazli retention — cok kisa)
    // =========================================================================

    private void purgeSnapshotFacts() {
        // Snapshot retention saat cinsinden — day partition drop yetmez,
        // timestamp-bazli DELETE yapmamiz lazim.
        // Once her instance icin cutoff bul.
        List<Map<String, Object>> instanceCutoffs = jdbc.queryForList("""
            select
              i.instance_pk,
              now() - make_interval(hours => coalesce(p.snapshot_retention_hours, 48)) as keep_from
            from control.instance_inventory i
            join control.retention_policy p on p.retention_policy_id = i.retention_policy_id
            where i.is_active and p.is_active and p.purge_enabled
            """);

        if (instanceCutoffs.isEmpty()) return;

        // Hard drop siniri (en uzun snapshot retention): partition drop icin
        LocalDate hardDropBefore = jdbc.queryForObject("""
            select (current_date - ceil(max(coalesce(p.snapshot_retention_hours, 48)) / 24.0)::int - 1)::date
            from control.retention_policy p
            where p.is_active and p.purge_enabled
            """,
            LocalDate.class
        );

        if (hardDropBefore != null) {
            log.info("Snapshot fact purge: partition drop siniri = {}", hardDropBefore);
            for (String table : SNAPSHOT_FACT_TABLES) {
                dropPartitionsBefore(table, hardDropBefore);
            }
        }

        // Saat hassasiyetinde batched delete
        for (Map<String, Object> row : instanceCutoffs) {
            long instancePk = ((Number) row.get("instance_pk")).longValue();
            java.sql.Timestamp ts = (java.sql.Timestamp) row.get("keep_from");
            OffsetDateTime keepFrom = ts.toInstant().atOffset(java.time.ZoneOffset.UTC);

            for (String table : SNAPSHOT_FACT_TABLES) {
                // Cogu yeni tablo sample_ts kullaniyor; sadece eski snapshot tablolari snapshot_ts
                String tsCol = (table.endsWith("_activity_snapshot")
                             || table.endsWith("_replication_snapshot")
                             || table.endsWith("_lock_snapshot")
                             || table.endsWith("_progress_snapshot"))
                    ? "snapshot_ts" : "sample_ts";
                batchedDeleteByTimestamp(table, tsCol, instancePk, keepFrom);
            }
        }
    }

    // =========================================================================
    // agg.pgss_hourly / pgss_daily purge
    // =========================================================================

    private void purgeHourlyAgg() {
        LocalDate dropBefore = jdbc.queryForObject("""
            select (current_date - max(coalesce(p.hourly_retention_days, p.hourly_retention_months * 30)))::date
            from control.retention_policy p
            where p.is_active and p.purge_enabled
            """,
            LocalDate.class
        );
        if (dropBefore == null) return;

        log.info("Hourly agg purge: drop siniri = {}", dropBefore);
        dropPartitionsBefore("agg.pgss_hourly", dropBefore);
    }

    private void purgeDailyAgg() {
        LocalDate dropBefore = jdbc.queryForObject("""
            select (current_date - max(coalesce(p.daily_retention_days, p.daily_retention_months * 30)))::date
            from control.retention_policy p
            where p.is_active and p.purge_enabled
            """,
            LocalDate.class
        );
        if (dropBefore == null) return;

        log.info("Daily agg purge: drop siniri = {}", dropBefore);
        dropPartitionsBefore("agg.pgss_daily", dropBefore);
    }

    // =========================================================================
    // ops tablolari (90 gun sabit)
    // =========================================================================

    private void purgeOps() {
        int deletedRuns = jdbc.update("""
            delete from ops.job_run
            where started_at < now() - make_interval(days => ?)
            """, OPS_RETENTION_DAYS);

        int deletedAlerts = jdbc.update("""
            delete from ops.alert
            where resolved_at is not null
              and resolved_at < now() - make_interval(days => ?)
            """, OPS_RETENTION_DAYS);

        if (deletedRuns > 0 || deletedAlerts > 0) {
            log.info("Ops purge: {} job_run, {} alert silindi", deletedRuns, deletedAlerts);
        }
    }

    // =========================================================================
    // Yardimci metotlar
    // =========================================================================

    /** Belirtilen tarihten onceki partisyonlari DETACH + DROP eder. */
    private void dropPartitionsBefore(String parentTable, LocalDate beforeDate) {
        String[] parts = parentTable.split("\\.", 2);
        String schema = parts[0];
        String table = parts[1];

        List<Map<String, Object>> partitions = jdbc.queryForList("""
            select
              nmsp.nspname || '.' || child.relname as full_name,
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

    private LocalDate extractStartDate(String bounds) {
        if (bounds == null) return null;
        try {
            int fromIdx = bounds.indexOf("'");
            int toIdx = bounds.indexOf("'", fromIdx + 1);
            if (fromIdx < 0 || toIdx < 0) return null;
            String dateStr = bounds.substring(fromIdx + 1, toIdx);
            if (dateStr.length() > 10) dateStr = dateStr.substring(0, 10);
            return LocalDate.parse(dateStr);
        } catch (Exception e) {
            return null;
        }
    }

    /** Instance bazli batched delete (day-araligi). */
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

    /** Saat-hassasiyetli batched delete (snapshot tablolari icin). */
    private void batchedDeleteByTimestamp(String parentTable, String tsColumn,
                                          long instancePk, OffsetDateTime keepFrom) {
        int totalDeleted = 0;
        int deleted;
        do {
            deleted = jdbc.update(
                "delete from " + parentTable +
                " where ctid in (" +
                "  select ctid from " + parentTable +
                "  where " + tsColumn + " < ?" +
                "    and instance_pk = ?" +
                "  limit ?" +
                ")",
                keepFrom, instancePk, DELETE_BATCH_SIZE
            );
            totalDeleted += deleted;
        } while (deleted >= DELETE_BATCH_SIZE);

        if (totalDeleted > 0) {
            log.info("Snapshot batched delete: {} — instance_pk={}, {} satir silindi",
                parentTable, instancePk, totalDeleted);
        }
    }
}
