package com.pgstat.collector.service;

import com.pgstat.collector.model.AlertCode;
import com.pgstat.collector.repository.AlertRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;

/**
 * Kullanici tanimli alert kurallarini degerlendiren servis.
 *
 * Her 60 saniyede calisir (JobOrchestrator tarafindan cagirilir).
 * control.alert_rule tablosundaki aktif kurallari okur, ilgili fact tablolarini
 * sorgular, eslikleri karsilastirir ve ops.alert tablosuna yazar/cozumler.
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

    /**
     * Tum aktif kurallari degerlendirir.
     * Her kural icin hedef instance'lari belirler, metrigi sorgular,
     * eslik karsilastirir ve alert yazar veya cozumler.
     */
    public void evaluate() {
        List<Map<String, Object>> rules = loadActiveRules();
        if (rules.isEmpty()) return;

        log.debug("Alert kural degerlendirmesi basliyor: {} kural", rules.size());

        for (Map<String, Object> rule : rules) {
            try {
                evaluateRule(rule);
            } catch (Exception e) {
                log.error("Kural degerlendirme hatasi — rule_id={}: {}",
                    rule.get("rule_id"), e.getMessage());
            }
        }
    }

    // =========================================================================
    // Kural degerlendirme
    // =========================================================================

    private void evaluateRule(Map<String, Object> rule) {
        long ruleId = ((Number) rule.get("rule_id")).longValue();
        String metricType = (String) rule.get("metric_type");
        String metricName = (String) rule.get("metric_name");
        String scope = (String) rule.get("scope");
        String aggregation = (String) rule.get("aggregation");
        int windowMinutes = ((Number) rule.get("evaluation_window_minutes")).intValue();
        String operator = (String) rule.get("condition_operator");
        BigDecimal warningThreshold = (BigDecimal) rule.get("warning_threshold");
        BigDecimal criticalThreshold = (BigDecimal) rule.get("critical_threshold");
        int cooldownMinutes = ((Number) rule.get("cooldown_minutes")).intValue();
        boolean autoResolve = Boolean.TRUE.equals(rule.get("auto_resolve"));
        Long scopeInstancePk = rule.get("instance_pk") != null
            ? ((Number) rule.get("instance_pk")).longValue() : null;
        String scopeServiceGroup = (String) rule.get("service_group");
        String ruleName = (String) rule.get("rule_name");

        // Hedef instance listesi
        List<Map<String, Object>> targets = loadTargetInstances(scope, scopeInstancePk, scopeServiceGroup);
        if (targets.isEmpty()) return;

        // Metrigi sorgula
        List<Map<String, Object>> metricRows = queryMetric(metricType, metricName, aggregation, windowMinutes);

        for (Map<String, Object> target : targets) {
            long instancePk = ((Number) target.get("instance_pk")).longValue();
            String serviceGroup = (String) target.get("service_group");

            // Bu instance icin metrik degerini bul
            BigDecimal value = findValueForInstance(metricRows, instancePk, metricName);
            if (value == null) continue;

            String alertKey = "rule:" + ruleId + ":instance:" + instancePk;

            // Cooldown kontrolu
            if (isInCooldown(ruleId, instancePk, cooldownMinutes)) {
                // Cooldown'dayken bile normal duruma don kontrolu yap
                if (autoResolve) {
                    String severity = determineSeverity(value, operator, warningThreshold, criticalThreshold);
                    if (severity == null) {
                        alertRepo.resolve(alertKey);
                        updateLastEval(ruleId, instancePk, value, null);
                    }
                }
                continue;
            }

            // Severity hesapla
            String severity = determineSeverity(value, operator, warningThreshold, criticalThreshold);
            String prevSeverity = getPrevSeverity(ruleId, instancePk);

            if (severity != null) {
                // Eslik asildi — alert yaz
                BigDecimal threshold = "critical".equals(severity) ? criticalThreshold : warningThreshold;
                String message = buildAlertMessage(metricName, value, operator, threshold, windowMinutes, aggregation);

                alertRepo.upsertWithSeverity(alertKey, AlertCode.USER_DEFINED_RULE,
                    severity, instancePk, serviceGroup, ruleName, message);

                updateLastEval(ruleId, instancePk, value, severity);
                log.debug("Rule alert: rule_id={} instance={} severity={} value={}", ruleId, instancePk, severity, value);

            } else if (prevSeverity != null && autoResolve) {
                // Normale dondü — coz
                alertRepo.resolve(alertKey);
                updateLastEval(ruleId, instancePk, value, null);
                log.debug("Rule alert resolved: rule_id={} instance={} value={}", ruleId, instancePk, value);
            } else {
                // Normal durum, sadece last_eval guncelle
                updateLastEval(ruleId, instancePk, value, null);
            }
        }
    }

    // =========================================================================
    // Metrik sorgulama
    // =========================================================================

    /**
     * metric_type'a gore dogru fact tablosunu sorgular.
     * Her satir: instance_pk + value (gerekirse relid de olabilir).
     */
    private List<Map<String, Object>> queryMetric(String metricType, String metricName,
                                                   String aggregation, int windowMinutes) {
        String aggFn = toSqlAgg(aggregation);
        String interval = windowMinutes + " minutes";

        return switch (metricType) {
            case "cluster_metric" -> queryClusterMetric(metricName, aggFn, interval);
            case "database_metric" -> queryDatabaseMetric(metricName, aggFn, interval);
            case "activity_metric" -> queryActivityMetric(metricName, interval);
            case "replication_metric" -> queryReplicationMetric(metricName, aggFn, interval);
            case "statement_metric" -> queryStatementMetric(metricName, aggFn, interval);
            case "table_metric" -> queryTableMetric(metricName, aggFn, interval);
            default -> {
                log.warn("Desteklenmeyen metric_type: {}", metricType);
                yield List.of();
            }
        };
    }

    private List<Map<String, Object>> queryClusterMetric(String metricName, String aggFn, String interval) {
        // Hesaplanan metrikler
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
        // Dogrudan kolon (wal_bytes, checkpoint_write_time vb.)
        return jdbc.queryForList(
            "select instance_pk, " + aggFn + "(" + sanitizeColumnName(metricName) + ") as value" +
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
            "select instance_pk, " + aggFn + "(" + sanitizeColumnName(metricName) + ") as value" +
            " from fact.pg_database_delta where sample_ts >= now() - ?::interval group by instance_pk",
            interval);
    }

    private List<Map<String, Object>> queryActivityMetric(String metricName, String interval) {
        // En son snapshot'taki sayim
        String stateFilter = switch (metricName) {
            case "active_count" -> "a.state = 'active'";
            case "idle_in_transaction_count" -> "a.state = 'idle in transaction'";
            case "waiting_count" -> "a.wait_event_type is not null";
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
            and """ + stateFilter + """
            group by a.instance_pk
            """, interval);
    }

    private List<Map<String, Object>> queryReplicationMetric(String metricName, String aggFn, String interval) {
        if ("replay_lag_seconds".equals(metricName)) {
            return jdbc.queryForList(
                "select r.instance_pk, " + aggFn + "(extract(epoch from r.replay_lag)::numeric) as value" +
                " from fact.pg_replication_snapshot r" +
                " where r.snapshot_ts >= now() - ?::interval group by r.instance_pk",
                interval);
        }
        return jdbc.queryForList(
            "select instance_pk, " + aggFn + "(" + sanitizeColumnName(metricName) + ") as value" +
            " from fact.pg_replication_snapshot where snapshot_ts >= now() - ?::interval group by instance_pk",
            interval);
    }

    private List<Map<String, Object>> queryStatementMetric(String metricName, String aggFn, String interval) {
        if ("avg_exec_time_ms".equals(metricName)) {
            return jdbc.queryForList(
                "select s.instance_pk, " + aggFn + "(s.total_exec_time_delta / nullif(s.calls_delta, 0)) as value" +
                " from fact.pgss_delta s" +
                " where s.sample_ts >= now() - ?::interval and s.calls_delta > 0" +
                " group by s.instance_pk",
                interval);
        }
        return jdbc.queryForList(
            "select instance_pk, " + aggFn + "(" + sanitizeColumnName(metricName) + ") as value" +
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
            "select instance_pk, " + aggFn + "(" + sanitizeColumnName(metricName) + ") as value" +
            " from fact.pg_table_stat_delta where sample_ts >= now() - ?::interval group by instance_pk",
            interval);
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
                   cooldown_minutes, auto_resolve
            from control.alert_rule
            where is_enabled = true
            order by rule_id
            """);
    }

    private List<Map<String, Object>> loadTargetInstances(String scope, Long instancePk, String serviceGroup) {
        return switch (scope) {
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

    private BigDecimal findValueForInstance(List<Map<String, Object>> rows, long instancePk, String metricName) {
        return rows.stream()
            .filter(r -> instancePk == ((Number) r.get("instance_pk")).longValue())
            .map(r -> r.get("value"))
            .filter(v -> v != null)
            .map(v -> v instanceof BigDecimal bd ? bd : new BigDecimal(v.toString()))
            .findFirst()
            .orElse(null);
    }

    /**
     * Warning mi critical mi yoksa normal mi degerlendirir.
     * Critical threshold once kontrol edilir.
     */
    private String determineSeverity(BigDecimal value, String op,
                                     BigDecimal warning, BigDecimal critical) {
        if (critical != null && compare(value, op, critical)) return "critical";
        if (warning != null && compare(value, op, warning)) return "warning";
        return null;
    }

    private boolean compare(BigDecimal value, String op, BigDecimal threshold) {
        int cmp = value.compareTo(threshold);
        return switch (op) {
            case ">" -> cmp > 0;
            case "<" -> cmp < 0;
            case ">=" -> cmp >= 0;
            case "<=" -> cmp <= 0;
            case "=" -> cmp == 0;
            default -> false;
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

    private String buildAlertMessage(String metricName, BigDecimal value,
                                     String operator, BigDecimal threshold,
                                     int windowMinutes, String aggregation) {
        return String.format("%s = %.2f (eşik: %s %.2f, son %d dk %s)",
            metricName, value.doubleValue(), operator, threshold.doubleValue(),
            windowMinutes, aggregation);
    }

    private String toSqlAgg(String aggregation) {
        return switch (aggregation) {
            case "sum" -> "sum";
            case "max" -> "max";
            case "min" -> "min";
            case "last" -> "last"; // PostgreSQL'de last yok — queryMetric'te ozel handle edilmeli
            case "count" -> "count";
            default -> "avg";
        };
    }

    /**
     * Kullanicidan gelen metric_name degerini SQL injection'a karsi temizler.
     * Sadece harf, rakam ve alt cizgiye izin verir.
     */
    private String sanitizeColumnName(String name) {
        if (!name.matches("[a-z_][a-z0-9_]*")) {
            throw new IllegalArgumentException("Gecersiz kolon adi: " + name);
        }
        return name;
    }
}
