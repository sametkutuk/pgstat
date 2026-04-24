package com.pgstat.collector.service;

import com.pgstat.collector.model.AlertCode;
import com.pgstat.collector.repository.AlertRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.List;
import java.util.Map;

/**
 * Kullanici tanimli alert kurallarini degerlendiren servis.
 *
 * Desteklenen evaluation_type degerleri:
 *   threshold      — sabit eslik karsilastirmasi (klasik)
 *   alltime_high   — tum zamanlarin maksimumunu asti mi?
 *   alltime_low    — tum zamanlarin minimumunun altina dustu mu?
 *   day_over_day   — dunku ayni saate gore % kac degisti?
 *   week_over_week — gecen haftanin ayni gunune gore % kac degisti?
 */
@Service
public class AlertRuleEvaluator {

    private static final Logger log = LoggerFactory.getLogger(AlertRuleEvaluator.class);

    private final JdbcTemplate jdbc;
    private final AlertRepository alertRepo;

    public AlertRuleEvaluator(JdbcTemplate jdbc, AlertRepository alertRepo) {
        this.jdbc = jdbc;
        this.alertRepo = alertRepo;
    }

    public void evaluate() {
        List<Map<String, Object>> rules = loadActiveRules();
        if (rules.isEmpty()) return;
        log.debug("Alert kural degerlendirmesi: {} kural", rules.size());
        for (Map<String, Object> rule : rules) {
            try {
                evaluateRule(rule);
            } catch (Exception e) {
                log.error("Kural degerlendirme hatasi rule_id={}: {}", rule.get("rule_id"), e.getMessage());
            }
        }
    }

    // =========================================================================
    // Kural degerlendirme — tip'e gore yonlendir
    // =========================================================================

    private void evaluateRule(Map<String, Object> rule) {
        String evalType = rule.get("evaluation_type") != null
            ? (String) rule.get("evaluation_type") : "threshold";

        switch (evalType) {
            case "threshold"      -> evaluateThreshold(rule);
            case "alltime_high"   -> evaluateAlltimeExtreme(rule, true);
            case "alltime_low"    -> evaluateAlltimeExtreme(rule, false);
            case "day_over_day"   -> evaluateTrend(rule, 1);
            case "week_over_week" -> evaluateTrend(rule, 7);
            default -> log.warn("Bilinmeyen evaluation_type: {}", evalType);
        }
    }

    // =========================================================================
    // threshold: sabit eslik karsilastirmasi
    // =========================================================================

    private void evaluateThreshold(Map<String, Object> rule) {
        long ruleId = toLong(rule.get("rule_id"));
        String metricType = (String) rule.get("metric_type");
        String metricName = (String) rule.get("metric_name");
        String aggregation = (String) rule.get("aggregation");
        int windowMinutes = toInt(rule.get("evaluation_window_minutes"));
        String operator = (String) rule.get("condition_operator");
        BigDecimal warningThreshold = toBD(rule.get("warning_threshold"));
        BigDecimal criticalThreshold = toBD(rule.get("critical_threshold"));
        int cooldownMinutes = toInt(rule.get("cooldown_minutes"));
        boolean autoResolve = Boolean.TRUE.equals(rule.get("auto_resolve"));
        String ruleName = (String) rule.get("rule_name");

        List<Map<String, Object>> targets = loadTargetInstances(rule);
        if (targets.isEmpty()) return;

        List<Map<String, Object>> metricRows = queryMetric(metricType, metricName,
            toSqlAgg(aggregation), windowMinutes + " minutes");

        for (Map<String, Object> target : targets) {
            long instancePk = toLong(target.get("instance_pk"));
            String serviceGroup = (String) target.get("service_group");
            BigDecimal value = findValueForInstance(metricRows, instancePk);
            if (value == null) continue;

            String alertKey = "rule:" + ruleId + ":instance:" + instancePk;

            if (isInCooldown(ruleId, instancePk, cooldownMinutes)) {
                if (autoResolve && determineSeverity(value, operator, warningThreshold, criticalThreshold) == null) {
                    alertRepo.resolve(alertKey);
                    updateLastEval(ruleId, instancePk, value, null);
                }
                continue;
            }

            String severity = determineSeverity(value, operator, warningThreshold, criticalThreshold);
            String prevSeverity = getPrevSeverity(ruleId, instancePk);

            if (severity != null) {
                BigDecimal threshold = "critical".equals(severity) ? criticalThreshold : warningThreshold;
                String message = buildThresholdMessage(metricName, value, operator, threshold, windowMinutes, aggregation);
                alertRepo.upsertWithSeverity(alertKey, AlertCode.USER_DEFINED_RULE,
                    severity, instancePk, serviceGroup, ruleName, message, ruleId);
                updateLastEval(ruleId, instancePk, value, severity);
            } else if (prevSeverity != null && autoResolve) {
                alertRepo.resolve(alertKey);
                updateLastEval(ruleId, instancePk, value, null);
            } else {
                updateLastEval(ruleId, instancePk, value, null);
            }
        }
    }

    // =========================================================================
    // alltime_high / alltime_low: tum zamanlar rekoru
    // =========================================================================

    private void evaluateAlltimeExtreme(Map<String, Object> rule, boolean isHigh) {
        long ruleId = toLong(rule.get("rule_id"));
        String metricType = (String) rule.get("metric_type");
        String metricName = (String) rule.get("metric_name");
        String aggregation = (String) rule.get("aggregation");
        int windowMinutes = toInt(rule.get("evaluation_window_minutes"));
        int minDataDays = toInt(rule.get("min_data_days"));
        int cooldownMinutes = toInt(rule.get("cooldown_minutes"));
        boolean autoResolve = Boolean.TRUE.equals(rule.get("auto_resolve"));
        String ruleName = (String) rule.get("rule_name");

        List<Map<String, Object>> targets = loadTargetInstances(rule);
        if (targets.isEmpty()) return;

        // Mevcut deger
        List<Map<String, Object>> currentRows = queryMetric(metricType, metricName,
            toSqlAgg(aggregation), windowMinutes + " minutes");

        for (Map<String, Object> target : targets) {
            long instancePk = toLong(target.get("instance_pk"));
            String serviceGroup = (String) target.get("service_group");
            BigDecimal currentValue = findValueForInstance(currentRows, instancePk);
            if (currentValue == null) continue;

            // Yeterli gecmis data var mi?
            if (!hasEnoughHistory(metricType, metricName, instancePk, minDataDays)) {
                log.debug("Yetersiz gecmis data rule_id={} instance={}", ruleId, instancePk);
                continue;
            }

            // Tum zamanlarin max/min degerini bul (son windowMinutes haric — kendisi sayilmasin)
            BigDecimal historicalExtreme = queryHistoricalExtreme(
                metricType, metricName, instancePk, toSqlAgg(aggregation), isHigh, windowMinutes);
            if (historicalExtreme == null) continue;

            String alertKey = "rule:" + ruleId + ":instance:" + instancePk;

            if (isInCooldown(ruleId, instancePk, cooldownMinutes)) {
                updateLastEval(ruleId, instancePk, currentValue, null);
                continue;
            }

            boolean isRecord = isHigh
                ? currentValue.compareTo(historicalExtreme) > 0
                : currentValue.compareTo(historicalExtreme) < 0;

            String prevSeverity = getPrevSeverity(ruleId, instancePk);

            if (isRecord) {
                String direction = isHigh ? "yüksek" : "düşük";
                String message = String.format(
                    "%s = %.4g — tüm zamanların en %s değeri (önceki: %.4g)",
                    metricName, currentValue.doubleValue(), direction, historicalExtreme.doubleValue());
                alertRepo.upsertWithSeverity(alertKey, AlertCode.USER_DEFINED_RULE,
                    "warning", instancePk, serviceGroup, ruleName, message);
                updateLastEval(ruleId, instancePk, currentValue, "warning");
            } else if (prevSeverity != null && autoResolve) {
                alertRepo.resolve(alertKey);
                updateLastEval(ruleId, instancePk, currentValue, null);
            } else {
                updateLastEval(ruleId, instancePk, currentValue, null);
            }
        }
    }

    // =========================================================================
    // day_over_day / week_over_week: trend karsilastirmasi
    // =========================================================================

    private void evaluateTrend(Map<String, Object> rule, int daysBack) {
        long ruleId = toLong(rule.get("rule_id"));
        String metricType = (String) rule.get("metric_type");
        String metricName = (String) rule.get("metric_name");
        String aggregation = (String) rule.get("aggregation");
        int windowMinutes = toInt(rule.get("evaluation_window_minutes"));
        BigDecimal changeThresholdPct = toBD(rule.get("change_threshold_pct"));
        int minDataDays = toInt(rule.get("min_data_days"));
        int cooldownMinutes = toInt(rule.get("cooldown_minutes"));
        boolean autoResolve = Boolean.TRUE.equals(rule.get("auto_resolve"));
        String ruleName = (String) rule.get("rule_name");

        if (changeThresholdPct == null) {
            log.warn("day_over_day/week_over_week kural rule_id={} icin change_threshold_pct tanimlanmamis", ruleId);
            return;
        }

        List<Map<String, Object>> targets = loadTargetInstances(rule);
        if (targets.isEmpty()) return;

        String aggFn = toSqlAgg(aggregation);

        // Mevcut penceredeki deger
        List<Map<String, Object>> currentRows = queryMetric(metricType, metricName,
            aggFn, windowMinutes + " minutes");

        // Gecmis ayni penceredeki deger (N gun once)
        List<Map<String, Object>> pastRows = queryMetricAtOffset(metricType, metricName,
            aggFn, windowMinutes, daysBack);

        for (Map<String, Object> target : targets) {
            long instancePk = toLong(target.get("instance_pk"));
            String serviceGroup = (String) target.get("service_group");

            BigDecimal current = findValueForInstance(currentRows, instancePk);
            BigDecimal past = findValueForInstance(pastRows, instancePk);
            if (current == null || past == null) continue;

            if (!hasEnoughHistory(metricType, metricName, instancePk, minDataDays)) continue;

            // % degisim hesapla: (current - past) / past * 100
            // past = 0 ise ve current > 0 ise sonsuz artis — her zaman tetikle
            BigDecimal changePct;
            if (past.compareTo(BigDecimal.ZERO) == 0) {
                changePct = current.compareTo(BigDecimal.ZERO) > 0
                    ? new BigDecimal("999999") : BigDecimal.ZERO;
            } else {
                changePct = current.subtract(past)
                    .divide(past.abs(), 4, RoundingMode.HALF_UP)
                    .multiply(new BigDecimal("100"))
                    .abs(); // mutlak degisim
            }

            String alertKey = "rule:" + ruleId + ":instance:" + instancePk;

            if (isInCooldown(ruleId, instancePk, cooldownMinutes)) {
                updateLastEval(ruleId, instancePk, changePct, null);
                continue;
            }

            String prevSeverity = getPrevSeverity(ruleId, instancePk);
            boolean triggered = changePct.compareTo(changeThresholdPct) > 0;

            if (triggered) {
                String period = daysBack == 1 ? "dün" : daysBack + " gün önce";
                String direction = current.compareTo(past) > 0 ? "arttı" : "azaldı";
                String message = String.format(
                    "%s = %.4g — %s'e göre (%.4g) %%%s %s (eşik: %%%s)",
                    metricName, current.doubleValue(), period, past.doubleValue(),
                    changePct.setScale(1, RoundingMode.HALF_UP), direction,
                    changeThresholdPct.setScale(0, RoundingMode.HALF_UP));

                // % degisim buyukse critical, kucukse warning
                String severity = changePct.compareTo(changeThresholdPct.multiply(new BigDecimal("2"))) > 0
                    ? "critical" : "warning";

                alertRepo.upsertWithSeverity(alertKey, AlertCode.USER_DEFINED_RULE,
                    severity, instancePk, serviceGroup, ruleName, message, ruleId);
                updateLastEval(ruleId, instancePk, changePct, severity);
                log.debug("Trend alert rule_id={} instance={} change={}%", ruleId, instancePk, changePct);
            } else if (prevSeverity != null && autoResolve) {
                alertRepo.resolve(alertKey);
                updateLastEval(ruleId, instancePk, changePct, null);
            } else {
                updateLastEval(ruleId, instancePk, changePct, null);
            }
        }
    }

    // =========================================================================
    // Metrik sorgulama — mevcut pencere
    // =========================================================================

    private List<Map<String, Object>> queryMetric(String metricType, String metricName,
                                                   String aggFn, String interval) {
        return switch (metricType) {
            case "cluster_metric"     -> queryClusterMetric(metricName, aggFn, interval);
            case "database_metric"    -> queryDatabaseMetric(metricName, aggFn, interval);
            case "activity_metric"    -> queryActivityMetric(metricName, interval);
            case "replication_metric" -> queryReplicationMetric(metricName, aggFn, interval);
            case "statement_metric"   -> queryStatementMetric(metricName, aggFn, interval);
            case "table_metric"       -> queryTableMetric(metricName, aggFn, interval);
            default -> { log.warn("Desteklenmeyen metric_type: {}", metricType); yield List.of(); }
        };
    }

    /**
     * N gun onceki ayni penceredeki degeri sorgular.
     * Ornek: windowMinutes=60, daysBack=1 → 25-26 saat onceki saatlik deger.
     */
    private List<Map<String, Object>> queryMetricAtOffset(String metricType, String metricName,
                                                           String aggFn, int windowMinutes, int daysBack) {
        // Pencere: now - daysBack*24h - windowMinutes .. now - daysBack*24h
        String intervalStart = (daysBack * 24 * 60 + windowMinutes) + " minutes";
        String intervalEnd   = (daysBack * 24 * 60) + " minutes";

        return switch (metricType) {
            case "cluster_metric"     -> queryClusterMetricBetween(metricName, aggFn, intervalStart, intervalEnd);
            case "database_metric"    -> queryDatabaseMetricBetween(metricName, aggFn, intervalStart, intervalEnd);
            case "activity_metric"    -> queryActivityMetricBetween(metricName, intervalStart, intervalEnd);
            case "replication_metric" -> queryReplicationMetricBetween(metricName, aggFn, intervalStart, intervalEnd);
            case "statement_metric"   -> queryStatementMetricBetween(metricName, aggFn, intervalStart, intervalEnd);
            case "table_metric"       -> queryTableMetricBetween(metricName, aggFn, intervalStart, intervalEnd);
            default -> List.of();
        };
    }

    // =========================================================================
    // Tum zamanlar max/min sorgusu
    // =========================================================================

    private BigDecimal queryHistoricalExtreme(String metricType, String metricName,
                                               long instancePk, String aggFn,
                                               boolean isHigh, int excludeLastMinutes) {
        String extremeFn = isHigh ? "max" : "min";
        // Mevcut pencereyi disla — son N dakikadan oncesi
        String tableSql = getMetricTableAndColumn(metricType, metricName);
        if (tableSql == null) return null;

        try {
            return jdbc.queryForObject(
                "select " + extremeFn + "(computed_value) from (" +
                "  select " + aggFn + "(" + tableSql.split("\\|")[1] + ") as computed_value" +
                "  from " + tableSql.split("\\|")[0] +
                "  where instance_pk = ?" +
                "    and " + tableSql.split("\\|")[2] + " < now() - ?::interval" +
                "  group by date_trunc('hour', " + tableSql.split("\\|")[2] + ")" +
                ") sub",
                BigDecimal.class, instancePk, excludeLastMinutes + " minutes");
        } catch (Exception e) {
            log.debug("Tarihi extreme sorgu hatasi metric={}: {}", metricName, e.getMessage());
            return null;
        }
    }

    /**
     * Metrik tipi icin "tablo|kolon|zaman_kolonu" formatinda meta doner.
     * Derived metrikler (cache_hit_ratio gibi) icin null doner — ayri handle edilmeli.
     */
    private String getMetricTableAndColumn(String metricType, String metricName) {
        return switch (metricType + "." + metricName) {
            case "cluster_metric.wal_bytes"              -> "fact.pg_cluster_delta|wal_bytes|sample_ts";
            case "cluster_metric.checkpoint_write_time"  -> "fact.pg_cluster_delta|checkpoint_write_time|sample_ts";
            case "cluster_metric.buffers_checkpoint"     -> "fact.pg_cluster_delta|buffers_checkpoint|sample_ts";
            case "database_metric.deadlocks"             -> "fact.pg_database_delta|deadlocks_delta|sample_ts";
            case "database_metric.temp_files"            -> "fact.pg_database_delta|temp_files_delta|sample_ts";
            case "database_metric.blk_read_time"         -> "fact.pg_database_delta|blk_read_time_delta|sample_ts";
            case "replication_metric.replay_lag_bytes"   -> "fact.pg_replication_snapshot|replay_lag_bytes|snapshot_ts";
            case "statement_metric.calls"                -> "fact.pgss_delta|calls_delta|sample_ts";
            case "statement_metric.temp_blks_written"    -> "fact.pgss_delta|temp_blks_written_delta|sample_ts";
            case "table_metric.seq_scan"                 -> "fact.pg_table_stat_delta|seq_scan_delta|sample_ts";
            default -> null; // derived veya desteklenmeyen
        };
    }

    // =========================================================================
    // Gecmis veri yeterliligi kontrolu
    // =========================================================================

    private boolean hasEnoughHistory(String metricType, String metricName,
                                     long instancePk, int minDataDays) {
        String table = getMetricTable(metricType);
        if (table == null) return false;
        try {
            Integer count = jdbc.queryForObject(
                "select count(distinct date_trunc('day', " + getTimeColumn(metricType) + "))" +
                " from " + table + " where instance_pk = ?" +
                " and " + getTimeColumn(metricType) + " >= now() - ?::interval",
                Integer.class, instancePk, minDataDays + " days");
            return count != null && count >= minDataDays;
        } catch (Exception e) {
            return false;
        }
    }

    private String getMetricTable(String metricType) {
        return switch (metricType) {
            case "cluster_metric"     -> "fact.pg_cluster_delta";
            case "database_metric"    -> "fact.pg_database_delta";
            case "activity_metric"    -> "fact.pg_activity_snapshot";
            case "replication_metric" -> "fact.pg_replication_snapshot";
            case "statement_metric"   -> "fact.pgss_delta";
            case "table_metric"       -> "fact.pg_table_stat_delta";
            default -> null;
        };
    }

    private String getTimeColumn(String metricType) {
        return "activity_metric".equals(metricType) || "replication_metric".equals(metricType)
            ? "snapshot_ts" : "sample_ts";
    }

    // =========================================================================
    // Metrik sorgulama — mevcut pencere (tek zaman noktasi)
    // =========================================================================

    private List<Map<String, Object>> queryClusterMetric(String metricName, String aggFn, String interval) {
        if ("cache_hit_ratio".equals(metricName)) {
            return jdbc.queryForList("""
                select d.instance_pk,
                       100.0 * sum(d.blks_hit_delta)::numeric
                         / nullif(sum(d.blks_hit_delta + d.blks_read_delta), 0) as value
                from fact.pg_database_delta d
                where d.sample_ts >= now() - ?::interval
                group by d.instance_pk
                """, interval);
        }
        return jdbc.queryForList(
            "select instance_pk, " + aggFn + "(" + sanitizeCol(metricName) + ") as value" +
            " from fact.pg_cluster_delta where sample_ts >= now() - ?::interval group by instance_pk",
            interval);
    }

    private List<Map<String, Object>> queryDatabaseMetric(String metricName, String aggFn, String interval) {
        if ("rollback_ratio".equals(metricName)) {
            return jdbc.queryForList("""
                select d.instance_pk,
                       100.0 * sum(d.xact_rollback_delta)::numeric
                         / nullif(sum(d.xact_commit_delta + d.xact_rollback_delta), 0) as value
                from fact.pg_database_delta d
                where d.sample_ts >= now() - ?::interval
                group by d.instance_pk
                """, interval);
        }
        return jdbc.queryForList(
            "select instance_pk, " + aggFn + "(" + sanitizeCol(metricName) + ") as value" +
            " from fact.pg_database_delta where sample_ts >= now() - ?::interval group by instance_pk",
            interval);
    }

    private List<Map<String, Object>> queryActivityMetric(String metricName, String interval) {
        String filter = switch (metricName) {
            case "active_count"              -> "a.state = 'active'";
            case "idle_in_transaction_count" -> "a.state = 'idle in transaction'";
            case "waiting_count"             -> "a.wait_event_type is not null";
            default -> "true";
        };
        return jdbc.queryForList("""
            select a.instance_pk, count(*) as value
            from fact.pg_activity_snapshot a
            where a.snapshot_ts = (
              select max(snapshot_ts) from fact.pg_activity_snapshot
              where instance_pk = a.instance_pk
            )
            and a.snapshot_ts >= now() - ?::interval
            and """ + filter + " group by a.instance_pk", interval);
    }

    private List<Map<String, Object>> queryReplicationMetric(String metricName, String aggFn, String interval) {
        if ("replay_lag_seconds".equals(metricName)) {
            return jdbc.queryForList(
                "select r.instance_pk, " + aggFn + "(extract(epoch from r.replay_lag)::numeric) as value" +
                " from fact.pg_replication_snapshot r" +
                " where r.snapshot_ts >= now() - ?::interval group by r.instance_pk", interval);
        }
        return jdbc.queryForList(
            "select instance_pk, " + aggFn + "(" + sanitizeCol(metricName) + ") as value" +
            " from fact.pg_replication_snapshot where snapshot_ts >= now() - ?::interval group by instance_pk",
            interval);
    }

    private List<Map<String, Object>> queryStatementMetric(String metricName, String aggFn, String interval) {
        if ("avg_exec_time_ms".equals(metricName)) {
            return jdbc.queryForList(
                "select s.instance_pk, " + aggFn + "(s.total_exec_time_delta / nullif(s.calls_delta, 0)) as value" +
                " from fact.pgss_delta s" +
                " where s.sample_ts >= now() - ?::interval and s.calls_delta > 0 group by s.instance_pk",
                interval);
        }
        return jdbc.queryForList(
            "select instance_pk, " + aggFn + "(" + sanitizeCol(metricName) + ") as value" +
            " from fact.pgss_delta where sample_ts >= now() - ?::interval group by instance_pk",
            interval);
    }

    private List<Map<String, Object>> queryTableMetric(String metricName, String aggFn, String interval) {
        if ("dead_tuple_ratio".equals(metricName)) {
            return jdbc.queryForList(
                "select t.instance_pk," +
                " " + aggFn + "(100.0 * t.n_dead_tup_estimate::numeric" +
                " / nullif(t.n_live_tup_estimate + t.n_dead_tup_estimate, 0)) as value" +
                " from fact.pg_table_stat_delta t" +
                " where t.sample_ts >= now() - ?::interval group by t.instance_pk",
                interval);
        }
        return jdbc.queryForList(
            "select instance_pk, " + aggFn + "(" + sanitizeCol(metricName) + ") as value" +
            " from fact.pg_table_stat_delta where sample_ts >= now() - ?::interval group by instance_pk",
            interval);
    }

    // =========================================================================
    // Metrik sorgulama — gecmis pencere (trend icin: start..end arasi)
    // =========================================================================

    private List<Map<String, Object>> queryClusterMetricBetween(String metricName, String aggFn,
                                                                  String intervalStart, String intervalEnd) {
        if ("cache_hit_ratio".equals(metricName)) {
            return jdbc.queryForList("""
                select d.instance_pk,
                       100.0 * sum(d.blks_hit_delta)::numeric
                         / nullif(sum(d.blks_hit_delta + d.blks_read_delta), 0) as value
                from fact.pg_database_delta d
                where d.sample_ts between now() - ?::interval and now() - ?::interval
                group by d.instance_pk
                """, intervalStart, intervalEnd);
        }
        return jdbc.queryForList(
            "select instance_pk, " + aggFn + "(" + sanitizeCol(metricName) + ") as value" +
            " from fact.pg_cluster_delta" +
            " where sample_ts between now() - ?::interval and now() - ?::interval group by instance_pk",
            intervalStart, intervalEnd);
    }

    private List<Map<String, Object>> queryDatabaseMetricBetween(String metricName, String aggFn,
                                                                   String intervalStart, String intervalEnd) {
        if ("rollback_ratio".equals(metricName)) {
            return jdbc.queryForList("""
                select d.instance_pk,
                       100.0 * sum(d.xact_rollback_delta)::numeric
                         / nullif(sum(d.xact_commit_delta + d.xact_rollback_delta), 0) as value
                from fact.pg_database_delta d
                where d.sample_ts between now() - ?::interval and now() - ?::interval
                group by d.instance_pk
                """, intervalStart, intervalEnd);
        }
        return jdbc.queryForList(
            "select instance_pk, " + aggFn + "(" + sanitizeCol(metricName) + ") as value" +
            " from fact.pg_database_delta" +
            " where sample_ts between now() - ?::interval and now() - ?::interval group by instance_pk",
            intervalStart, intervalEnd);
    }

    private List<Map<String, Object>> queryActivityMetricBetween(String metricName,
                                                                   String intervalStart, String intervalEnd) {
        String filter = switch (metricName) {
            case "active_count"              -> "a.state = 'active'";
            case "idle_in_transaction_count" -> "a.state = 'idle in transaction'";
            case "waiting_count"             -> "a.wait_event_type is not null";
            default -> "true";
        };
        return jdbc.queryForList(
            "select a.instance_pk, avg(cnt) as value from (" +
            "  select a.instance_pk, a.snapshot_ts, count(*) as cnt" +
            "  from fact.pg_activity_snapshot a" +
            "  where a.snapshot_ts between now() - ?::interval and now() - ?::interval" +
            "  and " + filter +
            "  group by a.instance_pk, a.snapshot_ts" +
            ") sub group by instance_pk",
            intervalStart, intervalEnd);
    }

    private List<Map<String, Object>> queryReplicationMetricBetween(String metricName, String aggFn,
                                                                      String intervalStart, String intervalEnd) {
        if ("replay_lag_seconds".equals(metricName)) {
            return jdbc.queryForList(
                "select r.instance_pk, " + aggFn + "(extract(epoch from r.replay_lag)::numeric) as value" +
                " from fact.pg_replication_snapshot r" +
                " where r.snapshot_ts between now() - ?::interval and now() - ?::interval group by r.instance_pk",
                intervalStart, intervalEnd);
        }
        return jdbc.queryForList(
            "select instance_pk, " + aggFn + "(" + sanitizeCol(metricName) + ") as value" +
            " from fact.pg_replication_snapshot" +
            " where snapshot_ts between now() - ?::interval and now() - ?::interval group by instance_pk",
            intervalStart, intervalEnd);
    }

    private List<Map<String, Object>> queryStatementMetricBetween(String metricName, String aggFn,
                                                                    String intervalStart, String intervalEnd) {
        if ("avg_exec_time_ms".equals(metricName)) {
            return jdbc.queryForList(
                "select s.instance_pk, " + aggFn + "(s.total_exec_time_delta / nullif(s.calls_delta, 0)) as value" +
                " from fact.pgss_delta s" +
                " where s.sample_ts between now() - ?::interval and now() - ?::interval" +
                " and s.calls_delta > 0 group by s.instance_pk",
                intervalStart, intervalEnd);
        }
        return jdbc.queryForList(
            "select instance_pk, " + aggFn + "(" + sanitizeCol(metricName) + ") as value" +
            " from fact.pgss_delta" +
            " where sample_ts between now() - ?::interval and now() - ?::interval group by instance_pk",
            intervalStart, intervalEnd);
    }

    private List<Map<String, Object>> queryTableMetricBetween(String metricName, String aggFn,
                                                               String intervalStart, String intervalEnd) {
        if ("dead_tuple_ratio".equals(metricName)) {
            return jdbc.queryForList(
                "select t.instance_pk," +
                " " + aggFn + "(100.0 * t.n_dead_tup_estimate::numeric" +
                " / nullif(t.n_live_tup_estimate + t.n_dead_tup_estimate, 0)) as value" +
                " from fact.pg_table_stat_delta t" +
                " where t.sample_ts between now() - ?::interval and now() - ?::interval group by t.instance_pk",
                intervalStart, intervalEnd);
        }
        return jdbc.queryForList(
            "select instance_pk, " + aggFn + "(" + sanitizeCol(metricName) + ") as value" +
            " from fact.pg_table_stat_delta" +
            " where sample_ts between now() - ?::interval and now() - ?::interval group by instance_pk",
            intervalStart, intervalEnd);
    }

    // =========================================================================
    // Yardimci metodlar
    // =========================================================================

    private List<Map<String, Object>> loadActiveRules() {
        return jdbc.queryForList("""
            select rule_id, rule_name, metric_type, metric_name, scope,
                   instance_pk, service_group, condition_operator,
                   warning_threshold, critical_threshold,
                   evaluation_window_minutes, aggregation,
                   evaluation_type, change_threshold_pct, min_data_days,
                   cooldown_minutes, auto_resolve
            from control.alert_rule
            where is_enabled = true
            order by rule_id
            """);
    }

    private List<Map<String, Object>> loadTargetInstances(Map<String, Object> rule) {
        String scope = (String) rule.get("scope");
        Long instancePk = rule.get("instance_pk") != null ? toLong(rule.get("instance_pk")) : null;
        String serviceGroup = (String) rule.get("service_group");

        return switch (scope != null ? scope : "all_instances") {
            case "specific_instance" -> jdbc.queryForList(
                "select instance_pk, service_group from control.instance_inventory" +
                " where instance_pk = ? and is_active = true", instancePk);
            case "service_group" -> jdbc.queryForList(
                "select instance_pk, service_group from control.instance_inventory" +
                " where service_group = ? and is_active = true", serviceGroup);
            default -> jdbc.queryForList(
                "select instance_pk, service_group from control.instance_inventory where is_active = true");
        };
    }

    private BigDecimal findValueForInstance(List<Map<String, Object>> rows, long instancePk) {
        return rows.stream()
            .filter(r -> r.get("instance_pk") != null && instancePk == toLong(r.get("instance_pk")))
            .map(r -> r.get("value"))
            .filter(v -> v != null)
            .map(v -> v instanceof BigDecimal bd ? bd : new BigDecimal(v.toString()))
            .findFirst()
            .orElse(null);
    }

    private String determineSeverity(BigDecimal value, String op,
                                     BigDecimal warning, BigDecimal critical) {
        if (critical != null && compare(value, op, critical)) return "critical";
        if (warning != null && compare(value, op, warning)) return "warning";
        return null;
    }

    private boolean compare(BigDecimal value, String op, BigDecimal threshold) {
        int cmp = value.compareTo(threshold);
        return switch (op) {
            case ">"  -> cmp > 0;
            case "<"  -> cmp < 0;
            case ">=" -> cmp >= 0;
            case "<=" -> cmp <= 0;
            case "="  -> cmp == 0;
            default   -> false;
        };
    }

    private boolean isInCooldown(long ruleId, long instancePk, int cooldownMinutes) {
        if (cooldownMinutes == 0) return false;
        Integer count = jdbc.queryForObject("""
            select count(*) from control.alert_rule_last_eval
            where rule_id = ? and instance_pk = ?
              and last_alert_at is not null
              and last_alert_at >= now() - (? || ' minutes')::interval
            """, Integer.class, ruleId, instancePk, cooldownMinutes);
        return count != null && count > 0;
    }

    private String getPrevSeverity(long ruleId, long instancePk) {
        try {
            return jdbc.queryForObject(
                "select current_severity from control.alert_rule_last_eval" +
                " where rule_id = ? and instance_pk = ?",
                String.class, ruleId, instancePk);
        } catch (Exception e) {
            return null;
        }
    }

    private void updateLastEval(long ruleId, long instancePk, BigDecimal value, String severity) {
        jdbc.update("""
            insert into control.alert_rule_last_eval
              (rule_id, instance_pk, last_evaluated_at, last_alert_at, last_value, current_severity)
            values (?, ?, now(), case when ? is not null then now() else null end, ?, ?)
            on conflict (rule_id, instance_pk) do update set
              last_evaluated_at = now(),
              last_alert_at = case
                when excluded.current_severity is not null then now()
                else control.alert_rule_last_eval.last_alert_at
              end,
              last_value = excluded.last_value,
              current_severity = excluded.current_severity
            """,
            ruleId, instancePk, severity, value, severity);
    }

    private String buildThresholdMessage(String metricName, BigDecimal value, String operator,
                                          BigDecimal threshold, int windowMinutes, String aggregation) {
        return String.format("%s = %.4g (eşik: %s %.4g, son %d dk %s)",
            metricName, value.doubleValue(), operator,
            threshold != null ? threshold.doubleValue() : 0,
            windowMinutes, aggregation);
    }

    private String toSqlAgg(String aggregation) {
        return switch (aggregation != null ? aggregation : "avg") {
            case "sum"   -> "sum";
            case "max"   -> "max";
            case "min"   -> "min";
            case "count" -> "count";
            default      -> "avg";
        };
    }

    private String sanitizeCol(String name) {
        if (name == null || !name.matches("[a-z_][a-z0-9_]*"))
            throw new IllegalArgumentException("Gecersiz kolon adi: " + name);
        return name;
    }

    private long toLong(Object v) { return ((Number) v).longValue(); }
    private int  toInt(Object v)  { return v != null ? ((Number) v).intValue() : 0; }
    private BigDecimal toBD(Object v) { return v instanceof BigDecimal bd ? bd : null; }
}
