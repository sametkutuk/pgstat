package com.pgstat.collector.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.List;
import java.util.Map;

@Service
public class SystemHealthEvaluator {

    private static final Logger log = LoggerFactory.getLogger(SystemHealthEvaluator.class);

    private static final String STAT_COLLECTION_FAILED = "system_stat_collection_failed";
    private static final String PARTITION_MISSING = "system_partition_missing";
    private static final String INSTANCE_UNREACHABLE = "system_instance_unreachable";
    private static final String COLLECTOR_STALE = "system_collector_stale";

    private static final List<String> PARTITION_PARENTS = List.of(
        "fact.pgss_delta",
        "fact.pg_database_delta",
        "fact.pg_table_stat_delta",
        "fact.pg_index_stat_delta",
        "fact.pg_cluster_delta",
        "fact.pg_io_stat_delta",
        "fact.pg_activity_snapshot",
        "fact.pg_lock_snapshot",
        "fact.pg_progress_snapshot",
        "fact.pg_wal_snapshot",
        "fact.pg_archiver_snapshot",
        "fact.pg_replication_snapshot",
        "fact.pg_replication_slot_snapshot"
    );

    private final JdbcTemplate jdbc;
    private final AlertService alertService;

    public SystemHealthEvaluator(JdbcTemplate jdbc, AlertService alertService) {
        this.jdbc = jdbc;
        this.alertService = alertService;
    }

    @Scheduled(fixedDelay = 5 * 60 * 1000L)
    public void evaluate() {
        log.debug("SystemHealthEvaluator evaluate cycle started");
        runCheck("stat_collection_failures", this::checkStatCollectionFailures);
        runCheck("partition_missing", this::checkPartitionMissing);
        runCheck("instance_unreachable", this::checkInstanceUnreachable);
        runCheck("collector_stale", this::checkCollectorStale);
        runCheck("cleanup_failed", this::checkCleanupFailed);
        runCheck("disk_full", this::checkDiskFull);
        log.debug("SystemHealthEvaluator evaluate cycle finished");
    }

    private void runCheck(String name, Runnable check) {
        try {
            check.run();
        } catch (Exception e) {
            log.warn("System health check failed: {} - {}", name, e.getMessage());
        }
    }

    private void checkStatCollectionFailures() {
        List<Map<String, Object>> rows = jdbc.queryForList("""
            select jri.instance_pk,
                   count(*)::int as fail_count,
                   max(coalesce(jri.error_text, jr.error_text)) as last_error
            from ops.job_run jr
            join ops.job_run_instance jri using (job_run_id)
            where jr.status = 'failed'
              and jr.started_at > now() - interval '5 minutes'
            group by jri.instance_pk
            """);

        for (Map<String, Object> row : rows) {
            Long instancePk = toLong(row.get("instance_pk"));
            if (instancePk == null || hasOpenAlert(INSTANCE_UNREACHABLE, instancePk)) continue;
            int failCount = toInt(row.get("fail_count"));
            String severity = failCount >= 5 ? "critical" : "warning";
            String key = "system.stat_collection_failed:instance=" + instancePk;
            String lastError = row.get("last_error") == null ? null : String.valueOf(row.get("last_error"));
            String details = new AlertDetailsBuilder()
                .setKind("system_health")
                .addContext("instance_pk", instancePk)
                .addContext("fail_count", failCount)
                .addContext("last_error", lastError)
                .build();
            alertService.upsertSystemAlert(
                STAT_COLLECTION_FAILED,
                key,
                severity,
                instancePk,
                "Stat collection failed",
                "Collector job failed " + failCount + " times in last 5 minutes.",
                details
            );
        }

        for (Map<String, Object> open : openAlerts(STAT_COLLECTION_FAILED)) {
            Long instancePk = toLong(open.get("instance_pk"));
            if (instancePk != null && hasRecentSuccessfulJob(instancePk)) {
                alertService.resolveSystemAlert(String.valueOf(open.get("alert_key")));
            }
        }
    }

    private void checkPartitionMissing() {
        ZoneId zone = ZoneId.systemDefault();
        LocalDate today = LocalDate.now(zone);
        for (String tableName : PARTITION_PARENTS) {
            MissingPartition missing = null;
            for (int offset = 0; offset <= 3; offset++) {
                OffsetDateTime target = today.plusDays(offset).atStartOfDay(zone).toOffsetDateTime();
                if (!partitionExists(tableName, target)) {
                    missing = new MissingPartition(offset, target);
                    break;
                }
            }

            String key = "system.partition_missing:table=" + tableName;
            if (missing == null) {
                alertService.resolveSystemAlert(key);
                continue;
            }

            String severity = missing.dayOffset == 0 ? "critical" : "warning";
            String details = new AlertDetailsBuilder()
                .setKind("system_health")
                .addContext("table_name", tableName)
                .addContext("day_offset", missing.dayOffset)
                .addContext("target_day", missing.target.toString())
                .build();
            alertService.upsertSystemAlert(
                PARTITION_MISSING,
                key,
                severity,
                null,
                "Partition missing",
                "Partition missing for " + tableName + " at day offset " + missing.dayOffset + ".",
                details
            );
        }
    }

    private boolean partitionExists(String fullTableName, OffsetDateTime target) {
        String[] parts = fullTableName.split("\\.", 2);
        if (parts.length != 2) return false;
        Boolean exists = jdbc.queryForObject("""
            select exists (
              select 1
              from pg_inherits i
              join pg_class child on child.oid = i.inhrelid
              join pg_class parent on parent.oid = i.inhparent
              join pg_namespace ns on ns.oid = parent.relnamespace
              where ns.nspname = ?
                and parent.relname = ?
                and exists (
                    select 1
                    from regexp_matches(
                        pg_get_expr(child.relpartbound, child.oid),
                        'FROM \\(''([^'']+)''\\) TO \\(''([^'']+)''\\)'
                    ) as m(bound)
                    where bound[1]::timestamptz <= ?::timestamptz
                      and bound[2]::timestamptz > ?::timestamptz
                )
            )
            """, Boolean.class, parts[0], parts[1], target, target);
        return Boolean.TRUE.equals(exists);
    }

    private void checkInstanceUnreachable() {
        List<Map<String, Object>> rows = jdbc.queryForList("""
            select instance_pk, consecutive_failures, last_error, last_error_at
            from control.instance_state
            where consecutive_failures >= 3
            """);

        for (Map<String, Object> row : rows) {
            Long instancePk = toLong(row.get("instance_pk"));
            if (instancePk == null) continue;
            int failures = toInt(row.get("consecutive_failures"));
            String severity = failures >= 10 ? "critical" : "warning";
            String key = "system.instance_unreachable:instance=" + instancePk;
            String lastError = row.get("last_error") == null ? null : String.valueOf(row.get("last_error"));
            String details = new AlertDetailsBuilder()
                .setKind("system_health")
                .addContext("instance_pk", instancePk)
                .addContext("consecutive_failures", failures)
                .addContext("last_error", lastError)
                .addContext("last_error_at", row.get("last_error_at"))
                .build();
            alertService.upsertSystemAlert(
                INSTANCE_UNREACHABLE,
                key,
                severity,
                instancePk,
                "Instance unreachable",
                "Collector connection failed " + failures + " times in a row.",
                details
            );
        }

        for (Map<String, Object> open : openAlerts(INSTANCE_UNREACHABLE)) {
            Long instancePk = toLong(open.get("instance_pk"));
            if (instancePk != null && getConsecutiveFailures(instancePk) == 0) {
                alertService.resolveSystemAlert(String.valueOf(open.get("alert_key")));
            }
        }
    }

    private void checkCollectorStale() {
        Integer lagSeconds = jdbc.queryForObject("""
            select extract(epoch from (now() - max(started_at)))::int as lag_seconds
            from ops.job_run
            """, Integer.class);
        String key = "system.collector_stale:global";
        if (lagSeconds == null) {
            alertService.upsertSystemAlert(
                COLLECTOR_STALE,
                key,
                "critical",
                null,
                "Collector stale",
                "No collector job_run record found.",
                new AlertDetailsBuilder().setKind("system_health").build()
            );
            return;
        }

        if (lagSeconds <= 300) {
            alertService.resolveSystemAlert(key);
            return;
        }

        String severity = lagSeconds >= 900 ? "critical" : "warning";
        String details = new AlertDetailsBuilder()
            .setKind("system_health")
            .addContext("lag_seconds", lagSeconds)
            .build();
        alertService.upsertSystemAlert(
            COLLECTOR_STALE,
            key,
            severity,
            null,
            "Collector stale",
            "No collector job_run in last " + lagSeconds + " seconds.",
            details
        );
    }

    private void checkCleanupFailed() {
        // TODO: Implement when cleanup tracking is persisted in backend tables.
        log.debug("Cleanup failed system check is a stub");
    }

    private void checkDiskFull() {
        // Disk full alert is written reactively by DB layer error handling; this check is no-op.
        log.debug("Disk full system check is no-op");
    }

    private boolean hasRecentSuccessfulJob(long instancePk) {
        Boolean exists = jdbc.queryForObject("""
            select exists (
              select 1
              from ops.job_run jr
              join ops.job_run_instance jri using (job_run_id)
              where jri.instance_pk = ?
                and jr.status = 'success'
                and jr.started_at > now() - interval '10 minutes'
            )
            """, Boolean.class, instancePk);
        return Boolean.TRUE.equals(exists);
    }

    private boolean hasOpenAlert(String alertCode, long instancePk) {
        Boolean exists = jdbc.queryForObject("""
            select exists (
              select 1
              from ops.alert
              where alert_code = ?
                and instance_pk = ?
                and status = 'open'
            )
            """, Boolean.class, alertCode, instancePk);
        return Boolean.TRUE.equals(exists);
    }

    private List<Map<String, Object>> openAlerts(String alertCode) {
        return jdbc.queryForList("""
            select alert_key, instance_pk
            from ops.alert
            where alert_code = ?
              and status = 'open'
            """, alertCode);
    }

    private int getConsecutiveFailures(long instancePk) {
        Integer failures = jdbc.queryForObject("""
            select coalesce(consecutive_failures, 0)
            from control.instance_state
            where instance_pk = ?
            """, Integer.class, instancePk);
        return failures == null ? 0 : failures;
    }

    private Long toLong(Object value) {
        return value instanceof Number n ? n.longValue() : null;
    }

    private int toInt(Object value) {
        return value instanceof Number n ? n.intValue() : 0;
    }

    private record MissingPartition(int dayOffset, OffsetDateTime target) {}
}
