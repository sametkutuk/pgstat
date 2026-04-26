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
 *   threshold       — sabit eslik karsilastirmasi (klasik)
 *   alltime_high    — tum zamanlarin maksimumunu asti mi?
 *   alltime_low     — tum zamanlarin minimumunun altina dustu mu?
 *   day_over_day    — dunku ayni saate gore % kac degisti?
 *   week_over_week  — gecen haftanin ayni gunune gore % kac degisti?
 *   spike           — son N dk vs onceki N dk ani sicrama
 *   flatline        — counter N dakika boyunca hic artmadi
 *   hourly_pattern  — bu saatin 4 haftalik ortalamasindan sapma
 */
@Service
public class AlertRuleEvaluator {

    private static final Logger log = LoggerFactory.getLogger(AlertRuleEvaluator.class);

    // Baseline haftalik guncelleme periyodu (7 gun)
    private static final int BASELINE_UPDATE_DAYS = 7;

    private final JdbcTemplate jdbc;
    private final AlertRepository alertRepo;
    private final AlertMessageRenderer renderer;

    public AlertRuleEvaluator(JdbcTemplate jdbc, AlertRepository alertRepo,
                              AlertMessageRenderer renderer) {
        this.jdbc = jdbc;
        this.alertRepo = alertRepo;
        this.renderer = renderer;
    }

    /**
     * Kural için title + message üretir. Kuralda template tanımlıysa onu render eder,
     * yoksa default user_defined_rule template'i, o da yoksa fallback string'leri kullanır.
     *
     * @param rule          alert_rule satırı
     * @param fallbackTitle template yoksa kullanılacak başlık (genellikle rule_name)
     * @param fallbackMsg   template yoksa kullanılacak mesaj (eski String.format çıktısı)
     * @param ctx           placeholder değerleri
     * @return [title, message]
     */
    private String[] buildAlertText(Map<String, Object> rule, String fallbackTitle,
                                     String fallbackMsg, Map<String, Object> ctx) {
        try {
            return renderer.renderForRule(rule, ctx, fallbackTitle, fallbackMsg);
        } catch (Exception e) {
            log.warn("Template render hatası rule_id={}: {}", rule.get("rule_id"), e.getMessage());
            return new String[]{fallbackTitle, fallbackMsg};
        }
    }

    /** Bir kuralın değerlendirmesinde kullanılan ortak context alanlarını doldurur. */
    private Map<String, Object> baseContext(Map<String, Object> rule, long instancePk,
                                             String severity) {
        Map<String, Object> ctx = new java.util.HashMap<>();
        ctx.put("rule_name", rule.get("rule_name"));
        ctx.put("rule_id", rule.get("rule_id"));
        ctx.put("metric", rule.get("metric_name"));
        ctx.put("metric_type", rule.get("metric_type"));
        ctx.put("aggregation", rule.get("aggregation"));
        ctx.put("operator", rule.get("condition_operator"));
        ctx.put("window", rule.get("evaluation_window_minutes"));
        ctx.put("warning_threshold", rule.get("warning_threshold"));
        ctx.put("critical_threshold", rule.get("critical_threshold"));
        ctx.put("severity", severity);
        ctx.put("instance_pk", instancePk);
        ctx.put("instance", lookupInstanceName(instancePk));
        return ctx;
    }

    private String lookupInstanceName(long instancePk) {
        try {
            return jdbc.queryForObject(
                "select display_name from control.instance_inventory where instance_pk = ?",
                String.class, instancePk);
        } catch (Exception e) {
            return "instance_pk=" + instancePk;
        }
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
            case "spike"          -> evaluateSpike(rule);
            case "flatline"       -> evaluateFlatline(rule);
            case "hourly_pattern" -> evaluateHourlyPattern(rule);
            case "adaptive"       -> evaluateAdaptive(rule);
            default -> log.warn("Bilinmeyen evaluation_type: {}", evalType);
        }
    }

    // =========================================================================
    // adaptive: control.metric_baseline tablosundan esik cekerek karsilastirir.
    // Sensitivity'ye gore avg + k*stddev (low=3, medium=2, high=1.5).
    // =========================================================================

    private void evaluateAdaptive(Map<String, Object> rule) {
        long ruleId = toLong(rule.get("rule_id"));
        String metricType = (String) rule.get("metric_type");
        String metricName = (String) rule.get("metric_name");
        String aggregation = (String) rule.get("aggregation");
        int windowMinutes = toInt(rule.get("evaluation_window_minutes"));
        int cooldownMinutes = toInt(rule.get("cooldown_minutes"));
        boolean autoResolve = Boolean.TRUE.equals(rule.get("auto_resolve"));
        String ruleName = (String) rule.get("rule_name");
        String sensitivity = rule.get("sensitivity") != null ? (String) rule.get("sensitivity") : "medium";

        List<Map<String, Object>> targets = loadTargetInstances(rule);
        if (targets.isEmpty()) return;

        String aggFn = toSqlAgg(aggregation);
        String metricKey = metricType.replace("_metric", "") + "." + metricName;

        // Mevcut pencere degeri
        List<Map<String, Object>> currentRows = queryMetric(metricType, metricName, aggFn, windowMinutes + " minutes");

        BigDecimal kMultiplier = switch (sensitivity) {
            case "low"    -> new BigDecimal("3.0");
            case "high"   -> new BigDecimal("1.5");
            default       -> new BigDecimal("2.0"); // medium
        };

        int currentHour = java.time.LocalDateTime.now().getHour();

        for (Map<String, Object> target : targets) {
            long instancePk = toLong(target.get("instance_pk"));
            String serviceGroup = (String) target.get("service_group");

            BigDecimal current = findValueForInstance(currentRows, instancePk);
            if (current == null) continue;

            // Baseline'i DB fonksiyonundan cek (saatlik, yoksa genel)
            Map<String, Object> baseline = loadBaseline(instancePk, metricKey, currentHour);
            if (baseline == null) {
                // Henuz baseline yok, adaptive kural pas gecilir
                updateLastEval(ruleId, instancePk, current, null);
                continue;
            }

            BigDecimal avg = toBDSafe(baseline.get("avg_value"));
            BigDecimal stddev = toBDSafe(baseline.get("stddev_value"));
            if (avg == null) {
                updateLastEval(ruleId, instancePk, current, null);
                continue;
            }
            if (stddev == null) stddev = BigDecimal.ZERO;

            // Esik: avg + k*stddev (upper), avg - k*stddev (lower, min 0)
            BigDecimal delta = stddev.multiply(kMultiplier);
            BigDecimal upperCritical = avg.add(delta.multiply(new BigDecimal("1.5")));
            BigDecimal upperWarning  = avg.add(delta);

            String alertKey = "rule:" + ruleId + ":instance:" + instancePk;

            if (isInCooldown(ruleId, instancePk, cooldownMinutes)) {
                updateLastEval(ruleId, instancePk, current, null);
                continue;
            }

            String severity = null;
            if (current.compareTo(upperCritical) > 0) severity = "critical";
            else if (current.compareTo(upperWarning) > 0) severity = "warning";

            String prevSeverity = getPrevSeverity(ruleId, instancePk);

            if (severity != null) {
                // Detaylı mesaj oluştur
                String message = String.format(
                    "%s = %s (baseline %02d:00 avg=%s, warning eşik=%s, critical eşik=%s, sensitivity=%s, pencere=%d dk)",
                    metricName, current.setScale(1, java.math.RoundingMode.HALF_UP),
                    currentHour,
                    avg.setScale(1, java.math.RoundingMode.HALF_UP),
                    upperWarning.setScale(1, java.math.RoundingMode.HALF_UP),
                    upperCritical.setScale(1, java.math.RoundingMode.HALF_UP),
                    sensitivity, windowMinutes);

                // Statement metrikleri için top query bilgisi ekle
                String detailsJson = null;
                if ("statement_metric".equals(metricType)) {
                    detailsJson = buildTopQueryDetails(instancePk, metricName, windowMinutes,
                        avg, upperWarning, upperCritical, currentHour, sensitivity);
                }

                // Şablon render — kuralda template varsa onu kullan
                Map<String, Object> ctx = baseContext(rule, instancePk, severity);
                ctx.put("value", current);
                ctx.put("baseline_avg", avg);
                ctx.put("baseline_hour", currentHour);
                ctx.put("upper_warning", upperWarning);
                ctx.put("upper_critical", upperCritical);
                ctx.put("threshold", "critical".equals(severity) ? upperCritical : upperWarning);
                ctx.put("sensitivity", sensitivity);
                String[] rendered = buildAlertText(rule, ruleName, message, ctx);

                if (detailsJson != null) {
                    alertRepo.upsert(alertKey, AlertCode.USER_DEFINED_RULE,
                        instancePk, serviceGroup, null, rendered[0], rendered[1], detailsJson);
                    // severity'yi ayrıca güncelle
                    jdbc.update("update ops.alert set severity = ? where alert_key = ?", severity, alertKey);
                } else {
                    alertRepo.upsertWithSeverity(alertKey, AlertCode.USER_DEFINED_RULE,
                        severity, instancePk, serviceGroup, rendered[0], rendered[1], ruleId);
                }
                updateLastEval(ruleId, instancePk, current, severity);
            } else if (prevSeverity != null && autoResolve) {
                alertRepo.resolve(alertKey);
                updateLastEval(ruleId, instancePk, current, null);
            } else {
                updateLastEval(ruleId, instancePk, current, null);
            }
        }
    }

    /**
     * Statement metrikleri icin top 5 query detayini JSON olarak olusturur.
     * Alert mesajina ek bilgi olarak eklenir.
     */
    private String buildTopQueryDetails(long instancePk, String metricName, int windowMinutes,
                                         BigDecimal baselineAvg, BigDecimal warningThreshold,
                                         BigDecimal criticalThreshold, int hour, String sensitivity) {
        try {
            String deltaCol = toFactColumn(metricName, "statement_metric");
            List<Map<String, Object>> topQueries = jdbc.queryForList(
                "select ss.queryid, left(qt.query_text, 200) as query_text, " +
                "       dbr.datname, rr.rolname, " +
                "       sum(d." + deltaCol + ") as metric_value, " +
                "       sum(d.calls_delta) as total_calls, " +
                "       sum(d.total_exec_time_ms_delta) as total_exec_time_ms " +
                "from fact.pgss_delta d " +
                "join dim.statement_series ss on ss.statement_series_id = d.statement_series_id " +
                "left join dim.query_text qt on qt.query_text_id = ss.query_text_id " +
                "left join dim.database_ref dbr on dbr.instance_pk = ss.instance_pk and dbr.dbid = ss.dbid " +
                "left join dim.role_ref rr on rr.instance_pk = ss.instance_pk and rr.userid = ss.userid " +
                "where d.instance_pk = ? and d.sample_ts >= now() - ?::interval " +
                "group by ss.queryid, qt.query_text, dbr.datname, rr.rolname " +
                "order by sum(d." + deltaCol + ") desc nulls last " +
                "limit 5",
                instancePk, windowMinutes + " minutes");

            if (topQueries.isEmpty()) return null;

            StringBuilder sb = new StringBuilder();
            sb.append("{\"baseline_hour\":").append(hour);
            sb.append(",\"baseline_avg\":").append(baselineAvg);
            sb.append(",\"warning_threshold\":").append(warningThreshold);
            sb.append(",\"critical_threshold\":").append(criticalThreshold);
            sb.append(",\"sensitivity\":\"").append(sensitivity).append("\"");
            sb.append(",\"window_minutes\":").append(windowMinutes);
            sb.append(",\"top_queries\":[");

            for (int i = 0; i < topQueries.size(); i++) {
                Map<String, Object> q = topQueries.get(i);
                if (i > 0) sb.append(",");
                sb.append("{\"queryid\":").append(q.get("queryid"));
                sb.append(",\"query_text\":\"").append(escapeJson(q.get("query_text")));
                sb.append("\",\"datname\":\"").append(q.get("datname") != null ? q.get("datname") : "");
                sb.append("\",\"rolname\":\"").append(q.get("rolname") != null ? q.get("rolname") : "");
                sb.append("\",\"metric_value\":").append(q.get("metric_value"));
                sb.append(",\"total_calls\":").append(q.get("total_calls"));
                sb.append(",\"total_exec_time_ms\":").append(q.get("total_exec_time_ms"));
                sb.append("}");
            }
            sb.append("]}");
            return sb.toString();
        } catch (Exception e) {
            log.debug("Top query detay hatasi: {}", e.getMessage());
            return null;
        }
    }

    private String escapeJson(Object val) {
        if (val == null) return "";
        return val.toString().replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ").replace("\r", "");
    }

    private Map<String, Object> loadBaseline(long instancePk, String metricKey, int hour) {
        try {
            List<Map<String, Object>> rows = jdbc.queryForList(
                "select * from control.get_baseline(?, ?, ?)",
                instancePk, metricKey, hour);
            if (rows.isEmpty()) {
                return null;
            }
            return rows.get(0);
        } catch (Exception e) {
            log.warn("Baseline okuma hatasi instance={} metric={} hour={}: {}", instancePk, metricKey, hour, e.getMessage());
            return null;
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

        // Granular tipler (statement/table/index) icin per-record threshold —
        // hangi sorgu/tablo/index esigi astiysa onu net soyleyen alert
        if (isGranularMetricType(metricType)) {
            evaluateThresholdPerRecord(rule, targets, metricType, metricName,
                windowMinutes, operator, warningThreshold, criticalThreshold,
                cooldownMinutes, autoResolve, ruleName, ruleId);
            return;
        }

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
                Map<String, Object> ctx = baseContext(rule, instancePk, severity);
                ctx.put("value", value);
                ctx.put("threshold", threshold);
                String[] rendered = buildAlertText(rule, ruleName, message, ctx);
                alertRepo.upsertWithSeverity(alertKey, AlertCode.USER_DEFINED_RULE,
                    severity, instancePk, serviceGroup, rendered[0], rendered[1], ruleId);
                updateLastEval(ruleId, instancePk, value, severity);
            } else if (prevSeverity != null && autoResolve) {
                alertRepo.resolve(alertKey);
                updateLastEval(ruleId, instancePk, value, null);
            } else {
                updateLastEval(ruleId, instancePk, value, null);
            }
        }
    }

    /** Per-record yapilacak granular metric tipleri */
    private static boolean isGranularMetricType(String metricType) {
        return "statement_metric".equals(metricType)
            || "table_metric".equals(metricType)
            || "index_metric".equals(metricType);
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

        List<Map<String, Object>> currentRows = queryMetric(metricType, metricName,
            toSqlAgg(aggregation), windowMinutes + " minutes");

        for (Map<String, Object> target : targets) {
            long instancePk = toLong(target.get("instance_pk"));
            String serviceGroup = (String) target.get("service_group");
            BigDecimal currentValue = findValueForInstance(currentRows, instancePk);
            if (currentValue == null) continue;

            if (!hasEnoughHistory(metricType, metricName, instancePk, minDataDays)) {
                log.debug("Yetersiz gecmis data rule_id={} instance={}", ruleId, instancePk);
                continue;
            }

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
                String direction = isHigh ? "yuksek" : "dusuk";
                String message = String.format(
                    "%s = %.4g — tum zamanlarin en %s degeri (onceki: %.4g)",
                    metricName, currentValue.doubleValue(), direction, historicalExtreme.doubleValue());
                Map<String, Object> ctx = baseContext(rule, instancePk, "warning");
                ctx.put("value", currentValue);
                ctx.put("previous_extreme", historicalExtreme);
                ctx.put("direction", direction);
                String[] rendered = buildAlertText(rule, ruleName, message, ctx);

                // Granular tipte: en cok katki yapan record'lari detail JSON'a koy
                String detailsJson = null;
                if (isGranularMetricType(metricType)) {
                    List<Map<String, Object>> contributors = findRecordsTopContributors(
                        instancePk, metricType, metricName, windowMinutes, isHigh);
                    if (!contributors.isEmpty()) {
                        detailsJson = buildPerRecordsJson(contributors, metricType, windowMinutes,
                            historicalExtreme.toPlainString(), "alltime_record_contributors");
                    }
                }

                if (detailsJson != null) {
                    alertRepo.upsert(alertKey, AlertCode.USER_DEFINED_RULE,
                        instancePk, serviceGroup, null, rendered[0], rendered[1], detailsJson);
                    jdbc.update("update ops.alert set severity = ? where alert_key = ?", "warning", alertKey);
                } else {
                    alertRepo.upsertWithSeverity(alertKey, AlertCode.USER_DEFINED_RULE,
                        "warning", instancePk, serviceGroup, rendered[0], rendered[1], ruleId);
                }
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

        List<Map<String, Object>> currentRows = queryMetric(metricType, metricName,
            aggFn, windowMinutes + " minutes");
        List<Map<String, Object>> pastRows = queryMetricAtOffset(metricType, metricName,
            aggFn, windowMinutes, daysBack);

        for (Map<String, Object> target : targets) {
            long instancePk = toLong(target.get("instance_pk"));
            String serviceGroup = (String) target.get("service_group");

            BigDecimal current = findValueForInstance(currentRows, instancePk);
            BigDecimal past = findValueForInstance(pastRows, instancePk);
            if (current == null || past == null) continue;

            if (!hasEnoughHistory(metricType, metricName, instancePk, minDataDays)) continue;

            BigDecimal changePct = computeChangePct(current, past);
            String alertKey = "rule:" + ruleId + ":instance:" + instancePk;

            if (isInCooldown(ruleId, instancePk, cooldownMinutes)) {
                updateLastEval(ruleId, instancePk, changePct, null);
                continue;
            }

            String prevSeverity = getPrevSeverity(ruleId, instancePk);
            boolean triggered = changePct.compareTo(changeThresholdPct) > 0;

            if (triggered) {
                String period = daysBack == 1 ? "dun" : daysBack + " gun once";
                String direction = current.compareTo(past) > 0 ? "artti" : "azaldi";
                String message = String.format(
                    "%s = %.4g — %s'e gore (%.4g) %%%s %s (esik: %%%s)",
                    metricName, current.doubleValue(), period, past.doubleValue(),
                    changePct.setScale(1, RoundingMode.HALF_UP), direction,
                    changeThresholdPct.setScale(0, RoundingMode.HALF_UP));

                String severity = changePct.compareTo(changeThresholdPct.multiply(new BigDecimal("2"))) > 0
                    ? "critical" : "warning";

                Map<String, Object> ctx = baseContext(rule, instancePk, severity);
                ctx.put("value", current);
                ctx.put("previous_value", past);
                ctx.put("change_pct", changePct);
                ctx.put("threshold", changeThresholdPct);
                ctx.put("period", period);
                ctx.put("direction", direction);
                String[] rendered = buildAlertText(rule, ruleName, message, ctx);

                // Granular tipte: en cok katki yapan record'lari detail JSON'a
                String detailsJson = null;
                if (isGranularMetricType(metricType)) {
                    List<Map<String, Object>> contributors = findRecordsTopContributors(
                        instancePk, metricType, metricName, windowMinutes, true);
                    if (!contributors.isEmpty()) {
                        detailsJson = buildPerRecordsJson(contributors, metricType, windowMinutes,
                            changeThresholdPct.toPlainString() + "%", "trend_top_contributors");
                    }
                }

                if (detailsJson != null) {
                    alertRepo.upsert(alertKey, AlertCode.USER_DEFINED_RULE,
                        instancePk, serviceGroup, null, rendered[0], rendered[1], detailsJson);
                    jdbc.update("update ops.alert set severity = ? where alert_key = ?", severity, alertKey);
                } else {
                    alertRepo.upsertWithSeverity(alertKey, AlertCode.USER_DEFINED_RULE,
                        severity, instancePk, serviceGroup, rendered[0], rendered[1], ruleId);
                }
                updateLastEval(ruleId, instancePk, changePct, severity);
            } else if (prevSeverity != null && autoResolve) {
                alertRepo.resolve(alertKey);
                updateLastEval(ruleId, instancePk, changePct, null);
            } else {
                updateLastEval(ruleId, instancePk, changePct, null);
            }
        }
    }

    // =========================================================================
    // spike: son N dk vs onceki N dk ani sicrama
    // =========================================================================

    private void evaluateSpike(Map<String, Object> rule) {
        long ruleId = toLong(rule.get("rule_id"));
        String metricType = (String) rule.get("metric_type");
        String metricName = (String) rule.get("metric_name");
        String aggregation = (String) rule.get("aggregation");
        int windowMinutes = toInt(rule.get("evaluation_window_minutes"));
        BigDecimal changeThresholdPct = toBD(rule.get("change_threshold_pct"));
        BigDecimal spikeFallbackPct = toBD(rule.get("spike_fallback_pct"));
        int minDataDays = toInt(rule.get("min_data_days"));
        int cooldownMinutes = toInt(rule.get("cooldown_minutes"));
        boolean autoResolve = Boolean.TRUE.equals(rule.get("auto_resolve"));
        String ruleName = (String) rule.get("rule_name");

        List<Map<String, Object>> targets = loadTargetInstances(rule);
        if (targets.isEmpty()) return;

        // Granular metric tipleri (statement/table/index) icin per-record spike —
        // instance toplam yerine her record icin ayri spike. Hangi sorgu/tablo/index
        // spike yapti net belli olur.
        if (isGranularMetricType(metricType)) {
            evaluateGranularSpike(rule, targets, metricType, metricName, windowMinutes,
                changeThresholdPct != null ? changeThresholdPct : new BigDecimal("100"),
                cooldownMinutes, autoResolve, ruleName, ruleId);
            return;
        }

        String aggFn = toSqlAgg(aggregation);

        // Mevcut pencere: son N dakika
        List<Map<String, Object>> currentRows = queryMetric(metricType, metricName,
            aggFn, windowMinutes + " minutes");

        // Onceki pencere: N-2N dakika arasi (non-overlapping)
        List<Map<String, Object>> prevRows = queryMetricAtOffset(metricType, metricName,
            aggFn, windowMinutes, 0); // daysBack=0 ama intervalStart = 2*window, intervalEnd = window

        for (Map<String, Object> target : targets) {
            long instancePk = toLong(target.get("instance_pk"));
            String serviceGroup = (String) target.get("service_group");

            BigDecimal current = findValueForInstance(currentRows, instancePk);
            BigDecimal prev = findValueForInstance(prevRows, instancePk);
            if (current == null) continue;

            String alertKey = "rule:" + ruleId + ":instance:" + instancePk;
            boolean hasHistory = hasEnoughHistory(metricType, metricName, instancePk, minDataDays);

            // Yeterli veri yoksa ve fallback tanimlanmissa: mutlak spike kontrolu
            if (!hasHistory) {
                if (spikeFallbackPct == null || prev == null) {
                    updateLastEval(ruleId, instancePk, current, null);
                    continue;
                }
                BigDecimal fallbackChange = computeChangePct(current, prev);
                if (fallbackChange.compareTo(spikeFallbackPct) > 0 && !isInCooldown(ruleId, instancePk, cooldownMinutes)) {
                    String message = String.format(
                        "%s = %.4g — anlık %.0f%% artis (yeni instance, fallback esik: %.0f%%)",
                        metricName, current.doubleValue(), fallbackChange.doubleValue(), spikeFallbackPct.doubleValue());
                    Map<String, Object> ctx = baseContext(rule, instancePk, "warning");
                    ctx.put("value", current);
                    ctx.put("previous_value", prev);
                    ctx.put("change_pct", fallbackChange);
                    ctx.put("threshold", spikeFallbackPct);
                    String[] rendered = buildAlertText(rule, ruleName, message, ctx);
                    alertRepo.upsertWithSeverity(alertKey, AlertCode.USER_DEFINED_RULE,
                        "warning", instancePk, serviceGroup, rendered[0], rendered[1], ruleId);
                    updateLastEval(ruleId, instancePk, current, "warning");
                } else {
                    updateLastEval(ruleId, instancePk, current, null);
                }
                continue;
            }

            if (prev == null || changeThresholdPct == null) {
                updateLastEval(ruleId, instancePk, current, null);
                continue;
            }

            BigDecimal changePct = computeChangePct(current, prev);

            if (isInCooldown(ruleId, instancePk, cooldownMinutes)) {
                updateLastEval(ruleId, instancePk, changePct, null);
                continue;
            }

            String prevSeverity = getPrevSeverity(ruleId, instancePk);
            boolean triggered = changePct.compareTo(changeThresholdPct) > 0;

            if (triggered) {
                String severity = changePct.compareTo(changeThresholdPct.multiply(new BigDecimal("3"))) > 0
                    ? "critical" : "warning";
                String message = String.format(
                    "%s: son %d dk = %.4g, onceki %d dk = %.4g — %.0f%% ani artis (esik: %.0f%%)",
                    metricName, windowMinutes, current.doubleValue(),
                    windowMinutes, prev.doubleValue(),
                    changePct.doubleValue(), changeThresholdPct.doubleValue());
                Map<String, Object> ctx = baseContext(rule, instancePk, severity);
                ctx.put("value", current);
                ctx.put("previous_value", prev);
                ctx.put("change_pct", changePct);
                ctx.put("threshold", changeThresholdPct);
                String[] rendered = buildAlertText(rule, ruleName, message, ctx);
                alertRepo.upsertWithSeverity(alertKey, AlertCode.USER_DEFINED_RULE,
                    severity, instancePk, serviceGroup, rendered[0], rendered[1], ruleId);
                updateLastEval(ruleId, instancePk, changePct, severity);
            } else if (prevSeverity != null && autoResolve) {
                alertRepo.resolve(alertKey);
                updateLastEval(ruleId, instancePk, changePct, null);
            } else {
                updateLastEval(ruleId, instancePk, changePct, null);
            }
        }
    }

    // =========================================================================
    // statement_metric spike: per-query bazli, hangi sorgu spike yapti soyler
    // =========================================================================

    /**
     * Granular spike (statement/table/index): her record icin son N dk vs
     * onceki N dk karsilastirmasi. En cok artan record icin alert.
     */
    private void evaluateGranularSpike(Map<String, Object> rule, List<Map<String, Object>> targets,
                                        String metricType, String metricName, int windowMinutes,
                                        BigDecimal thresholdPct, int cooldownMinutes,
                                        boolean autoResolve, String ruleName, long ruleId) {
        for (Map<String, Object> target : targets) {
            long instancePk = toLong(target.get("instance_pk"));
            String serviceGroup = (String) target.get("service_group");
            String alertKey = "rule:" + ruleId + ":instance:" + instancePk;

            if (isInCooldown(ruleId, instancePk, cooldownMinutes)) continue;

            List<Map<String, Object>> spiking = findRecordsSpiking(
                instancePk, metricType, metricName, windowMinutes, thresholdPct);

            String prevSeverity = getPrevSeverity(ruleId, instancePk);

            if (spiking.isEmpty()) {
                if (prevSeverity != null && autoResolve) alertRepo.resolve(alertKey);
                updateLastEval(ruleId, instancePk, BigDecimal.ZERO, null);
                continue;
            }

            Map<String, Object> top = spiking.get(0);
            BigDecimal currentVal = toBDSafe(top.get("current_val"));
            BigDecimal prevVal    = toBDSafe(top.get("prev_val"));
            BigDecimal changePct  = toBDSafe(top.get("change_pct"));
            String severity = changePct.compareTo(thresholdPct.multiply(new BigDecimal("3"))) > 0
                ? "critical" : "warning";

            Map<String, Object> ctx = baseContext(rule, instancePk, severity);
            ctx.put("value", currentVal);
            ctx.put("current_value", currentVal);
            ctx.put("previous_value", prevVal);
            ctx.put("change_pct", changePct);
            ctx.put("threshold", thresholdPct);
            ctx.put("window", windowMinutes);
            populateRecordCtx(ctx, top, metricType);

            String fallbackMsg = buildPerRecordSpikeMessage(metricType, metricName, top,
                prevVal, currentVal, changePct, windowMinutes);
            String detailsJson = buildPerRecordsJson(spiking, metricType, windowMinutes,
                thresholdPct.toPlainString() + "%", "spike");

            String code = templateCodeForType(metricType, "spike");
            String[] rendered = renderWithCode(rule, ctx, ruleName, fallbackMsg, code);

            alertRepo.upsert(alertKey, AlertCode.USER_DEFINED_RULE,
                instancePk, serviceGroup, null, rendered[0], rendered[1], detailsJson);
            jdbc.update("update ops.alert set severity = ? where alert_key = ?", severity, alertKey);

            updateLastEval(ruleId, instancePk, changePct, severity);
        }
    }

    private String buildPerRecordSpikeMessage(String metricType, String metricName,
                                               Map<String, Object> rec, BigDecimal prevVal,
                                               BigDecimal currentVal, BigDecimal changePct,
                                               int windowMinutes) {
        return switch (metricType) {
            case "statement_metric" -> String.format(
                "Sorgu spike: %s = %s (onceki: %s, %s%% artis, %d dk). DB=%s User=%s Q=%s",
                metricName, currentVal, prevVal, changePct, windowMinutes,
                rec.get("datname"), rec.get("rolname"),
                trimText((String) rec.get("query_text"), 80));
            case "table_metric" -> String.format(
                "Tablo spike: %s = %s (onceki: %s, %s%% artis, %d dk). Tablo=%s.%s",
                metricName, currentVal, prevVal, changePct, windowMinutes,
                rec.get("schemaname"), rec.get("relname"));
            case "index_metric" -> String.format(
                "Index spike: %s = %s (onceki: %s, %s%% artis, %d dk). Index=%s.%s",
                metricName, currentVal, prevVal, changePct, windowMinutes,
                rec.get("schemaname"), rec.get("indexrelname"));
            default -> "Spike";
        };
    }

    /**
     * Trend/alltime/hourly_pattern alert'lerine zenginlestirme: hangi record en cok
     * katki yapti? Top 10 record'u doner — alert detail'a JSON olarak konur.
     */
    private List<Map<String, Object>> findRecordsTopContributors(long instancePk,
                                                                  String metricType, String metricName,
                                                                  int windowMinutes, boolean isHigh) {
        try {
            String order = isHigh ? "desc" : "asc";
            return switch (metricType) {
                case "statement_metric" -> {
                    String col = toFactColumn(metricName, "statement_metric");
                    yield jdbc.queryForList(
                        "select ss.queryid, sum(d." + col + ")::numeric as current_val," +
                        "       left(coalesce(qt.query_text, '?'), 200) as query_text," +
                        "       dbr.datname, rr.rolname" +
                        "  from fact.pgss_delta d" +
                        "  join dim.statement_series ss on ss.statement_series_id = d.statement_series_id" +
                        "  left join dim.query_text qt on qt.query_text_id = ss.query_text_id" +
                        "  left join dim.database_ref dbr on dbr.instance_pk = ss.instance_pk and dbr.dbid = ss.dbid" +
                        "  left join dim.role_ref    rr  on rr.instance_pk  = ss.instance_pk and rr.userid  = ss.userid" +
                        "  where d.instance_pk = ? and d.sample_ts > now() - ?::interval" +
                        "  group by ss.queryid, qt.query_text, dbr.datname, rr.rolname" +
                        "  having sum(d." + col + ") is not null" +
                        "  order by current_val " + order + " nulls last limit 10",
                        instancePk, windowMinutes + " minutes");
                }
                case "table_metric" -> {
                    String col = toFactColumn(metricName, "table_metric");
                    yield jdbc.queryForList(
                        "select t.schemaname, t.relname, sum(t." + col + ")::numeric as current_val," +
                        "       max(t.n_dead_tup_estimate) as dead_tup, max(t.n_live_tup_estimate) as live_tup," +
                        "       dbr.datname" +
                        "  from fact.pg_table_stat_delta t" +
                        "  left join dim.database_ref dbr on dbr.instance_pk = t.instance_pk and dbr.dbid = t.dbid" +
                        "  where t.instance_pk = ? and t.sample_ts > now() - ?::interval" +
                        "  group by t.schemaname, t.relname, dbr.datname" +
                        "  having sum(t." + col + ") is not null" +
                        "  order by current_val " + order + " nulls last limit 10",
                        instancePk, windowMinutes + " minutes");
                }
                case "index_metric" -> {
                    String col = toFactColumn(metricName, "index_metric");
                    yield jdbc.queryForList(
                        "select i.schemaname, i.indexrelname, i.table_relname," +
                        "       sum(i." + col + ")::numeric as current_val, dbr.datname" +
                        "  from fact.pg_index_stat_delta i" +
                        "  left join dim.database_ref dbr on dbr.instance_pk = i.instance_pk and dbr.dbid = i.dbid" +
                        "  where i.instance_pk = ? and i.sample_ts > now() - ?::interval" +
                        "  group by i.schemaname, i.indexrelname, i.table_relname, dbr.datname" +
                        "  having sum(i." + col + ") is not null" +
                        "  order by current_val " + order + " nulls last limit 10",
                        instancePk, windowMinutes + " minutes");
                }
                default -> java.util.Collections.emptyList();
            };
        } catch (Exception e) {
            log.debug("findRecordsTopContributors hatasi: {}", e.getMessage());
            return java.util.Collections.emptyList();
        }
    }

    /** Generic spike SQL — her granular tipte uygun query */
    private List<Map<String, Object>> findRecordsSpiking(long instancePk, String metricType,
                                                          String metricName, int windowMinutes,
                                                          BigDecimal thresholdPct) {
        try {
            return switch (metricType) {
                case "statement_metric" -> findTopSpikingStatements(instancePk,
                    toFactColumn(metricName, "statement_metric"), windowMinutes, thresholdPct);

                case "table_metric" -> {
                    String col = toFactColumn(metricName, "table_metric");
                    yield jdbc.queryForList(
                        "with curr as (" +
                        "  select t.schemaname, t.relname, t.dbid, sum(t." + col + ")::numeric as current_val" +
                        "  from fact.pg_table_stat_delta t" +
                        "  where t.instance_pk = ? and t.sample_ts > now() - ?::interval" +
                        "  group by t.schemaname, t.relname, t.dbid" +
                        "), prev as (" +
                        "  select t.schemaname, t.relname, t.dbid, sum(t." + col + ")::numeric as prev_val" +
                        "  from fact.pg_table_stat_delta t" +
                        "  where t.instance_pk = ? and t.sample_ts > now() - ?::interval" +
                        "    and t.sample_ts <= now() - ?::interval" +
                        "  group by t.schemaname, t.relname, t.dbid" +
                        ")" +
                        "select c.schemaname, c.relname, c.dbid, c.current_val, coalesce(p.prev_val, 0) as prev_val," +
                        "       case when coalesce(p.prev_val, 0) = 0 and c.current_val > 0 then 9999.0" +
                        "            else round((c.current_val - p.prev_val) * 100.0 / nullif(p.prev_val, 0), 1) end as change_pct," +
                        "       dbr.datname" +
                        "  from curr c" +
                        "  left join prev p on p.schemaname = c.schemaname and p.relname = c.relname and p.dbid = c.dbid" +
                        "  left join dim.database_ref dbr on dbr.instance_pk = ? and dbr.dbid = c.dbid" +
                        "  where c.current_val > 0" +
                        "    and (case when coalesce(p.prev_val, 0) = 0 and c.current_val > 0 then 9999.0" +
                        "              else (c.current_val - p.prev_val) * 100.0 / nullif(p.prev_val, 0) end) > ?" +
                        "  order by change_pct desc nulls last limit 10",
                        instancePk, windowMinutes + " minutes",
                        instancePk, (windowMinutes * 2) + " minutes", windowMinutes + " minutes",
                        instancePk, thresholdPct);
                }

                case "index_metric" -> {
                    String col = toFactColumn(metricName, "index_metric");
                    yield jdbc.queryForList(
                        "with curr as (" +
                        "  select i.schemaname, i.indexrelname, i.table_relname, i.dbid, sum(i." + col + ")::numeric as current_val" +
                        "  from fact.pg_index_stat_delta i" +
                        "  where i.instance_pk = ? and i.sample_ts > now() - ?::interval" +
                        "  group by i.schemaname, i.indexrelname, i.table_relname, i.dbid" +
                        "), prev as (" +
                        "  select i.schemaname, i.indexrelname, i.dbid, sum(i." + col + ")::numeric as prev_val" +
                        "  from fact.pg_index_stat_delta i" +
                        "  where i.instance_pk = ? and i.sample_ts > now() - ?::interval and i.sample_ts <= now() - ?::interval" +
                        "  group by i.schemaname, i.indexrelname, i.dbid" +
                        ")" +
                        "select c.schemaname, c.indexrelname, c.table_relname, c.dbid, c.current_val, coalesce(p.prev_val, 0) as prev_val," +
                        "       case when coalesce(p.prev_val, 0) = 0 and c.current_val > 0 then 9999.0" +
                        "            else round((c.current_val - p.prev_val) * 100.0 / nullif(p.prev_val, 0), 1) end as change_pct," +
                        "       dbr.datname" +
                        "  from curr c" +
                        "  left join prev p on p.schemaname = c.schemaname and p.indexrelname = c.indexrelname and p.dbid = c.dbid" +
                        "  left join dim.database_ref dbr on dbr.instance_pk = ? and dbr.dbid = c.dbid" +
                        "  where c.current_val > 0" +
                        "    and (case when coalesce(p.prev_val, 0) = 0 and c.current_val > 0 then 9999.0" +
                        "              else (c.current_val - p.prev_val) * 100.0 / nullif(p.prev_val, 0) end) > ?" +
                        "  order by change_pct desc nulls last limit 10",
                        instancePk, windowMinutes + " minutes",
                        instancePk, (windowMinutes * 2) + " minutes", windowMinutes + " minutes",
                        instancePk, thresholdPct);
                }

                default -> java.util.Collections.emptyList();
            };
        } catch (Exception e) {
            log.warn("findRecordsSpiking hatasi {}/{} instance={}: {}",
                metricType, metricName, instancePk, e.getMessage());
            return java.util.Collections.emptyList();
        }
    }

    /**
     * Her queryid icin: son N dk delta toplami vs onceki N dk delta toplami,
     * threshold'u asanlari yuzde sapma sirasina gore doner.
     */
    private List<Map<String, Object>> findTopSpikingStatements(long instancePk,
                                                                String deltaCol,
                                                                int windowMinutes,
                                                                BigDecimal thresholdPct) {
        try {
            // current: now - N dk → now
            // prev:    now - 2*N dk → now - N dk
            String sql =
                "with current_window as (" +
                "  select ss.statement_series_id, ss.queryid, ss.dbid, ss.userid," +
                "         sum(d." + deltaCol + ") as current_val" +
                "  from fact.pgss_delta d" +
                "  join dim.statement_series ss on ss.statement_series_id = d.statement_series_id" +
                "  where d.instance_pk = ? and d.sample_ts > now() - ?::interval" +
                "  group by ss.statement_series_id, ss.queryid, ss.dbid, ss.userid" +
                "), prev_window as (" +
                "  select ss.statement_series_id," +
                "         sum(d." + deltaCol + ") as prev_val" +
                "  from fact.pgss_delta d" +
                "  join dim.statement_series ss on ss.statement_series_id = d.statement_series_id" +
                "  where d.instance_pk = ?" +
                "    and d.sample_ts > now() - ?::interval" +
                "    and d.sample_ts <= now() - ?::interval" +
                "  group by ss.statement_series_id" +
                ")" +
                "select c.queryid, c.dbid, c.userid," +
                "       coalesce(c.current_val, 0)::numeric as current_val," +
                "       coalesce(p.prev_val, 0)::numeric as prev_val," +
                "       case when coalesce(p.prev_val,0) = 0 and coalesce(c.current_val,0) > 0 then 9999.0" +
                "            when coalesce(p.prev_val,0) = 0 then 0.0" +
                "            else round(((c.current_val::numeric - p.prev_val::numeric) * 100.0 / nullif(p.prev_val::numeric, 0))::numeric, 1)" +
                "       end as change_pct," +
                "       left(coalesce(qt.query_text, '?'), 300) as query_text," +
                "       dbr.datname, rr.rolname" +
                "  from current_window c" +
                "  left join prev_window p on p.statement_series_id = c.statement_series_id" +
                "  left join dim.statement_series ss on ss.statement_series_id = c.statement_series_id" +
                "  left join dim.query_text qt on qt.query_text_id = ss.query_text_id" +
                "  left join dim.database_ref dbr on dbr.instance_pk = ? and dbr.dbid = c.dbid" +
                "  left join dim.role_ref    rr  on rr.instance_pk  = ? and rr.userid  = c.userid" +
                "  where c.current_val > 0" +
                "    and (case when coalesce(p.prev_val,0) = 0 and coalesce(c.current_val,0) > 0 then 9999.0" +
                "              when coalesce(p.prev_val,0) = 0 then 0.0" +
                "              else (c.current_val::numeric - p.prev_val::numeric) * 100.0 / nullif(p.prev_val::numeric, 0)" +
                "         end) > ?::numeric" +
                "  order by change_pct desc nulls last" +
                "  limit 10";

            return jdbc.queryForList(sql,
                instancePk, windowMinutes + " minutes",         // current_window
                instancePk, (windowMinutes * 2) + " minutes",   // prev_window from
                            windowMinutes + " minutes",         // prev_window to
                instancePk, instancePk,                         // refs
                thresholdPct);
        } catch (Exception e) {
            log.warn("findTopSpikingStatements hatasi instance={}: {}", instancePk, e.getMessage());
            return java.util.Collections.emptyList();
        }
    }

    // =========================================================================
    // Per-record THRESHOLD evaluator — statement/table/index granularitesinde
    // =========================================================================

    /**
     * Granular metric tiplerinde threshold kontrolu.
     * statement_metric → her queryid icin
     * table_metric    → her schema.relname icin
     * index_metric    → her schemaname.indexrelname icin
     *
     * Esigi asan kayitlar bulunursa en yuksek olani icin alert + tum liste
     * details_json'da yer alir.
     */
    private void evaluateThresholdPerRecord(Map<String, Object> rule, List<Map<String, Object>> targets,
                                             String metricType, String metricName,
                                             int windowMinutes, String operator,
                                             BigDecimal warningThreshold, BigDecimal criticalThreshold,
                                             int cooldownMinutes, boolean autoResolve,
                                             String ruleName, long ruleId) {
        for (Map<String, Object> target : targets) {
            long instancePk = toLong(target.get("instance_pk"));
            String serviceGroup = (String) target.get("service_group");
            String alertKey = "rule:" + ruleId + ":instance:" + instancePk;

            if (isInCooldown(ruleId, instancePk, cooldownMinutes)) continue;

            // Esigi asan kayitlari bul (max threshold = warning, critical varsa hari)
            BigDecimal probeThreshold = warningThreshold != null ? warningThreshold : criticalThreshold;
            if (probeThreshold == null) continue;

            List<Map<String, Object>> exceeding = findRecordsExceedingThreshold(
                instancePk, metricType, metricName, windowMinutes, operator, probeThreshold);

            String prevSeverity = getPrevSeverity(ruleId, instancePk);

            if (exceeding.isEmpty()) {
                if (prevSeverity != null && autoResolve) alertRepo.resolve(alertKey);
                updateLastEval(ruleId, instancePk, BigDecimal.ZERO, null);
                continue;
            }

            // En yuksek deger ana hedef
            Map<String, Object> top = exceeding.get(0);
            BigDecimal currentVal = toBDSafe(top.get("current_val"));
            String severity = determineSeverity(currentVal, operator, warningThreshold, criticalThreshold);
            if (severity == null) {
                if (prevSeverity != null && autoResolve) alertRepo.resolve(alertKey);
                updateLastEval(ruleId, instancePk, currentVal, null);
                continue;
            }
            BigDecimal threshold = "critical".equals(severity) ? criticalThreshold : warningThreshold;

            Map<String, Object> ctx = baseContext(rule, instancePk, severity);
            ctx.put("value", currentVal);
            ctx.put("current_value", currentVal);
            ctx.put("threshold", threshold);
            ctx.put("window", windowMinutes);
            populateRecordCtx(ctx, top, metricType);

            String fallbackMsg = buildPerRecordThresholdMessage(metricType, metricName, top,
                operator, threshold, windowMinutes);
            String detailsJson = buildPerRecordsJson(exceeding, metricType, windowMinutes,
                threshold.toPlainString(), "exceeding_threshold");

            // Template kodu: granular tip icin uygun statement_spike-benzeri code,
            // yoksa user_defined_rule
            String alertCodeForTemplate = templateCodeForType(metricType, "threshold");
            String[] rendered = renderWithCode(rule, ctx, ruleName, fallbackMsg, alertCodeForTemplate);

            alertRepo.upsert(alertKey, AlertCode.USER_DEFINED_RULE,
                instancePk, serviceGroup, null, rendered[0], rendered[1], detailsJson);
            jdbc.update("update ops.alert set severity = ? where alert_key = ?", severity, alertKey);

            updateLastEval(ruleId, instancePk, currentVal, severity);
        }
    }

    /** Granular tip + evaluation type icin uygun template code'u secer. */
    private static String templateCodeForType(String metricType, String evalType) {
        // V032: statement_spike, V033: statement_threshold, table_threshold, vb.
        return switch (metricType) {
            case "statement_metric" -> "statement_" + evalType;
            case "table_metric"     -> "table_"     + evalType;
            case "index_metric"     -> "index_"     + evalType;
            default -> "user_defined_rule";
        };
    }

    /** Render: granular code varsa onu kullan, yoksa rule template, yoksa user_defined fallback */
    private String[] renderWithCode(Map<String, Object> rule, Map<String, Object> ctx,
                                     String fallbackTitle, String fallbackMsg, String code) {
        String userTitleTpl = rule.get("title_template") != null ? rule.get("title_template").toString().trim() : "";
        String userMsgTpl   = rule.get("message_template") != null ? rule.get("message_template").toString().trim() : "";
        if (!userTitleTpl.isEmpty() || !userMsgTpl.isEmpty()) {
            return buildAlertText(rule, fallbackTitle, fallbackMsg, ctx);
        }
        try {
            return renderer.renderForCode(code, ctx, fallbackTitle, fallbackMsg);
        } catch (Exception e) {
            return new String[]{fallbackTitle, fallbackMsg};
        }
    }

    /** Per-record context'i doldurur (queryid/relation/index_name vs.) */
    private void populateRecordCtx(Map<String, Object> ctx, Map<String, Object> rec, String metricType) {
        switch (metricType) {
            case "statement_metric" -> {
                ctx.put("queryid", rec.get("queryid"));
                ctx.put("spiking_query", trimText((String) rec.get("query_text"), 200));
                ctx.put("query_text",   trimText((String) rec.get("query_text"), 200));
                ctx.put("database", rec.get("datname"));
                ctx.put("user",     rec.get("rolname"));
            }
            case "table_metric" -> {
                String relation = rec.get("schemaname") + "." + rec.get("relname");
                ctx.put("relation", relation);
                ctx.put("table",    relation);
                ctx.put("schema",   rec.get("schemaname"));
                ctx.put("database", rec.get("datname"));
                ctx.put("dead_tup", rec.get("dead_tup"));
                ctx.put("live_tup", rec.get("live_tup"));
            }
            case "index_metric" -> {
                String idx = rec.get("schemaname") + "." + rec.get("indexrelname");
                ctx.put("index",    idx);
                ctx.put("table",    rec.get("schemaname") + "." + rec.get("table_relname"));
                ctx.put("schema",   rec.get("schemaname"));
                ctx.put("database", rec.get("datname"));
            }
        }
    }

    private static String trimText(String s, int max) {
        if (s == null) return "";
        return s.length() > max ? s.substring(0, max) + "…" : s;
    }

    /** Esigi asan top-N kaydi (per-record) granular metric tipinde */
    private List<Map<String, Object>> findRecordsExceedingThreshold(long instancePk,
                                                                    String metricType, String metricName,
                                                                    int windowMinutes, String operator,
                                                                    BigDecimal threshold) {
        String op = sanitizeOperator(operator);
        try {
            return switch (metricType) {
                case "statement_metric" -> jdbc.queryForList(
                    "select ss.queryid, ss.dbid, ss.userid," +
                    "       sum(d." + toFactColumn(metricName, "statement_metric") + ")::numeric as current_val," +
                    "       left(coalesce(qt.query_text, '?'), 300) as query_text," +
                    "       dbr.datname, rr.rolname" +
                    "  from fact.pgss_delta d" +
                    "  join dim.statement_series ss on ss.statement_series_id = d.statement_series_id" +
                    "  left join dim.query_text qt on qt.query_text_id = ss.query_text_id" +
                    "  left join dim.database_ref dbr on dbr.instance_pk = ss.instance_pk and dbr.dbid = ss.dbid" +
                    "  left join dim.role_ref    rr  on rr.instance_pk  = ss.instance_pk and rr.userid  = ss.userid" +
                    "  where d.instance_pk = ? and d.sample_ts > now() - ?::interval" +
                    "  group by ss.queryid, ss.dbid, ss.userid, qt.query_text, dbr.datname, rr.rolname" +
                    "  having sum(d." + toFactColumn(metricName, "statement_metric") + ")::numeric " + op + " ?" +
                    "  order by current_val desc limit 10",
                    instancePk, windowMinutes + " minutes", threshold);

                case "table_metric" -> {
                    String col = toFactColumn(metricName, "table_metric");
                    if ("dead_tuple_ratio".equals(metricName)) {
                        yield jdbc.queryForList(
                            "select t.schemaname, t.relname, t.dbid," +
                            "       100.0 * t.n_dead_tup_estimate::numeric / nullif(t.n_live_tup_estimate + t.n_dead_tup_estimate, 0) as current_val," +
                            "       t.n_dead_tup_estimate as dead_tup, t.n_live_tup_estimate as live_tup, dbr.datname" +
                            "  from fact.pg_table_stat_delta t" +
                            "  left join dim.database_ref dbr on dbr.instance_pk = t.instance_pk and dbr.dbid = t.dbid" +
                            "  where t.instance_pk = ? and t.sample_ts > now() - ?::interval" +
                            "    and (t.n_live_tup_estimate + t.n_dead_tup_estimate) > 1000" +
                            "    and 100.0 * t.n_dead_tup_estimate::numeric / nullif(t.n_live_tup_estimate + t.n_dead_tup_estimate, 0) " + op + " ?" +
                            "  order by current_val desc limit 10",
                            instancePk, windowMinutes + " minutes", threshold);
                    }
                    yield jdbc.queryForList(
                        "select t.schemaname, t.relname, t.dbid," +
                        "       sum(t." + col + ")::numeric as current_val," +
                        "       max(t.n_dead_tup_estimate) as dead_tup, max(t.n_live_tup_estimate) as live_tup," +
                        "       dbr.datname" +
                        "  from fact.pg_table_stat_delta t" +
                        "  left join dim.database_ref dbr on dbr.instance_pk = t.instance_pk and dbr.dbid = t.dbid" +
                        "  where t.instance_pk = ? and t.sample_ts > now() - ?::interval" +
                        "  group by t.schemaname, t.relname, t.dbid, dbr.datname" +
                        "  having sum(t." + col + ")::numeric " + op + " ?" +
                        "  order by current_val desc limit 10",
                        instancePk, windowMinutes + " minutes", threshold);
                }

                case "index_metric" -> {
                    String col = toFactColumn(metricName, "index_metric");
                    yield jdbc.queryForList(
                        "select i.schemaname, i.indexrelname, i.table_relname, i.dbid," +
                        "       sum(i." + col + ")::numeric as current_val, dbr.datname" +
                        "  from fact.pg_index_stat_delta i" +
                        "  left join dim.database_ref dbr on dbr.instance_pk = i.instance_pk and dbr.dbid = i.dbid" +
                        "  where i.instance_pk = ? and i.sample_ts > now() - ?::interval" +
                        "  group by i.schemaname, i.indexrelname, i.table_relname, i.dbid, dbr.datname" +
                        "  having sum(i." + col + ")::numeric " + op + " ?" +
                        "  order by current_val desc limit 10",
                        instancePk, windowMinutes + " minutes", threshold);
                }

                default -> java.util.Collections.emptyList();
            };
        } catch (Exception e) {
            log.warn("findRecordsExceedingThreshold hatasi {}/{} instance={}: {}",
                metricType, metricName, instancePk, e.getMessage());
            return java.util.Collections.emptyList();
        }
    }

    private static String sanitizeOperator(String op) {
        if (op == null) return ">";
        return switch (op) {
            case ">", "<", ">=", "<=", "=" -> op;
            default -> ">";
        };
    }

    private String buildPerRecordThresholdMessage(String metricType, String metricName,
                                                   Map<String, Object> rec, String operator,
                                                   BigDecimal threshold, int windowMinutes) {
        return switch (metricType) {
            case "statement_metric" -> String.format(
                "Sorgu esigi asti: %s = %s (%s %s, %d dk pencere). DB=%s User=%s Query=%s",
                metricName, rec.get("current_val"), operator, threshold,
                windowMinutes, rec.get("datname"), rec.get("rolname"),
                trimText((String) rec.get("query_text"), 80));
            case "table_metric" -> String.format(
                "Tablo esigi asti: %s = %s (%s %s, %d dk). Tablo=%s.%s DB=%s",
                metricName, rec.get("current_val"), operator, threshold,
                windowMinutes, rec.get("schemaname"), rec.get("relname"), rec.get("datname"));
            case "index_metric" -> String.format(
                "Index esigi asti: %s = %s (%s %s, %d dk). Index=%s.%s",
                metricName, rec.get("current_val"), operator, threshold,
                windowMinutes, rec.get("schemaname"), rec.get("indexrelname"));
            default -> "Esik asildi";
        };
    }

    private String buildPerRecordsJson(List<Map<String, Object>> records, String metricType,
                                        int windowMinutes, String thresholdStr, String reason) {
        try {
            StringBuilder sb = new StringBuilder();
            sb.append("{\"reason\":\"").append(reason).append("\"");
            sb.append(",\"window_minutes\":").append(windowMinutes);
            sb.append(",\"threshold\":\"").append(thresholdStr).append("\"");
            sb.append(",\"metric_type\":\"").append(metricType).append("\"");
            sb.append(",\"records\":[");
            for (int i = 0; i < records.size(); i++) {
                Map<String, Object> r = records.get(i);
                if (i > 0) sb.append(",");
                sb.append("{");
                boolean first = true;
                for (Map.Entry<String, Object> e : r.entrySet()) {
                    if (!first) sb.append(",");
                    first = false;
                    sb.append("\"").append(e.getKey()).append("\":");
                    Object v = e.getValue();
                    if (v == null) sb.append("null");
                    else if (v instanceof Number) sb.append(v);
                    else sb.append("\"").append(escapeJson(v.toString())).append("\"");
                }
                sb.append("}");
            }
            sb.append("]}");
            return sb.toString();
        } catch (Exception e) {
            return null;
        }
    }

    /** Spike eden sorgu listesini JSON olarak detail icin paketler */
    private String buildSpikingQueriesJson(List<Map<String, Object>> spiking,
                                            int windowMinutes, BigDecimal thresholdPct) {
        try {
            StringBuilder sb = new StringBuilder();
            sb.append("{\"window_minutes\":").append(windowMinutes);
            sb.append(",\"threshold_pct\":").append(thresholdPct);
            sb.append(",\"spiking_queries\":[");
            for (int i = 0; i < spiking.size(); i++) {
                Map<String, Object> q = spiking.get(i);
                if (i > 0) sb.append(",");
                sb.append("{\"queryid\":").append(q.get("queryid"));
                sb.append(",\"datname\":\"").append(q.get("datname") != null ? q.get("datname") : "");
                sb.append("\",\"rolname\":\"").append(q.get("rolname") != null ? q.get("rolname") : "");
                sb.append("\",\"current_val\":").append(q.get("current_val"));
                sb.append(",\"prev_val\":").append(q.get("prev_val"));
                sb.append(",\"change_pct\":").append(q.get("change_pct"));
                sb.append(",\"query_text\":\"").append(escapeJson(q.get("query_text")));
                sb.append("\"}");
            }
            sb.append("]}");
            return sb.toString();
        } catch (Exception e) {
            return null;
        }
    }

    // =========================================================================
    // flatline: counter N dakika boyunca hic artmadi
    // =========================================================================

    private void evaluateFlatline(Map<String, Object> rule) {
        long ruleId = toLong(rule.get("rule_id"));
        String metricType = (String) rule.get("metric_type");
        String metricName = (String) rule.get("metric_name");
        int flatlineMinutes = toInt(rule.get("flatline_minutes"));
        int cooldownMinutes = toInt(rule.get("cooldown_minutes"));
        boolean autoResolve = Boolean.TRUE.equals(rule.get("auto_resolve"));
        String ruleName = (String) rule.get("rule_name");

        if (flatlineMinutes <= 0) flatlineMinutes = 30;

        String tableSql = getMetricTableAndColumn(metricType, metricName);
        if (tableSql == null) {
            log.debug("flatline desteklenmiyor metric={}.{}", metricType, metricName);
            return;
        }
        String[] parts = tableSql.split("\\|");
        String table = parts[0], col = parts[1], timeCol = parts[2];

        List<Map<String, Object>> targets = loadTargetInstances(rule);
        if (targets.isEmpty()) return;

        for (Map<String, Object> target : targets) {
            long instancePk = toLong(target.get("instance_pk"));
            String serviceGroup = (String) target.get("service_group");

            // Flatline: flatlineMinutes suresi icinde degerin hic artip artmadigini kontrol et.
            // max - min == 0 ise counter durmus demektir.
            try {
                Map<String, Object> stats = jdbc.queryForMap(
                    "select max(" + col + ")::numeric as mx, min(" + col + ")::numeric as mn, count(*) as cnt" +
                    " from " + table +
                    " where instance_pk = ? and " + timeCol + " >= now() - ?::interval",
                    instancePk, flatlineMinutes + " minutes");

                long cnt = stats.get("cnt") != null ? ((Number) stats.get("cnt")).longValue() : 0;
                if (cnt < 2) continue; // yeterli olcum yok

                BigDecimal mx = toBDSafe(stats.get("mx"));
                BigDecimal mn = toBDSafe(stats.get("mn"));
                if (mx == null || mn == null) continue;

                String alertKey = "rule:" + ruleId + ":instance:" + instancePk;
                boolean isFlatline = mx.compareTo(mn) == 0;
                String prevSeverity = getPrevSeverity(ruleId, instancePk);

                if (isFlatline && !isInCooldown(ruleId, instancePk, cooldownMinutes)) {
                    String message = String.format(
                        "%s son %d dakikada hic degismedi (deger: %.4g) — servis durmus olabilir",
                        metricName, flatlineMinutes, mx.doubleValue());
                    Map<String, Object> ctx = baseContext(rule, instancePk, "critical");
                    ctx.put("value", mx);
                    ctx.put("flatline_minutes", flatlineMinutes);
                    String[] rendered = buildAlertText(rule, ruleName, message, ctx);
                    alertRepo.upsertWithSeverity(alertKey, AlertCode.USER_DEFINED_RULE,
                        "critical", instancePk, serviceGroup, rendered[0], rendered[1], ruleId);
                    updateLastEval(ruleId, instancePk, mx, "critical");
                } else if (!isFlatline && prevSeverity != null && autoResolve) {
                    alertRepo.resolve(alertKey);
                    updateLastEval(ruleId, instancePk, mx, null);
                } else {
                    updateLastEval(ruleId, instancePk, mx != null ? mx : BigDecimal.ZERO, null);
                }
            } catch (Exception e) {
                log.debug("Flatline sorgu hatasi rule_id={} instance={}: {}", ruleId, instancePk, e.getMessage());
            }
        }
    }

    // =========================================================================
    // hourly_pattern: bu saatin 4 haftalik ortalamasindan sapma.
    // Yeterli veri yoksa spike_fallback_pct ile anlık pencere karsilastirmasi yapar.
    // =========================================================================

    private void evaluateHourlyPattern(Map<String, Object> rule) {
        long ruleId = toLong(rule.get("rule_id"));
        String metricType = (String) rule.get("metric_type");
        String metricName = (String) rule.get("metric_name");
        String aggregation = (String) rule.get("aggregation");
        int windowMinutes = toInt(rule.get("evaluation_window_minutes"));
        BigDecimal changeThresholdPct = toBD(rule.get("change_threshold_pct"));
        BigDecimal spikeFallbackPct = toBD(rule.get("spike_fallback_pct"));
        int minDataDays = toInt(rule.get("min_data_days"));
        int cooldownMinutes = toInt(rule.get("cooldown_minutes"));
        boolean autoResolve = Boolean.TRUE.equals(rule.get("auto_resolve"));
        String ruleName = (String) rule.get("rule_name");

        if (changeThresholdPct == null) return;

        List<Map<String, Object>> targets = loadTargetInstances(rule);
        if (targets.isEmpty()) return;

        String aggFn = toSqlAgg(aggregation);

        List<Map<String, Object>> currentRows = queryMetric(metricType, metricName,
            aggFn, windowMinutes + " minutes");

        for (Map<String, Object> target : targets) {
            long instancePk = toLong(target.get("instance_pk"));
            String serviceGroup = (String) target.get("service_group");

            BigDecimal current = findValueForInstance(currentRows, instancePk);
            if (current == null) continue;

            String alertKey = "rule:" + ruleId + ":instance:" + instancePk;
            boolean hasHistory = hasEnoughHistory(metricType, metricName, instancePk, minDataDays);

            if (!hasHistory) {
                // Yeni instance: spike_fallback_pct ile anlık onceki pencereyle karsilastir
                if (spikeFallbackPct == null) {
                    updateLastEval(ruleId, instancePk, current, null);
                    continue;
                }
                List<Map<String, Object>> prevRows = queryMetricAtOffset(metricType, metricName,
                    aggFn, windowMinutes, 0);
                BigDecimal prev = findValueForInstance(prevRows, instancePk);
                if (prev == null || prev.compareTo(BigDecimal.ZERO) == 0) {
                    updateLastEval(ruleId, instancePk, current, null);
                    continue;
                }
                BigDecimal fallbackChange = computeChangePct(current, prev);
                if (fallbackChange.compareTo(spikeFallbackPct) > 0 && !isInCooldown(ruleId, instancePk, cooldownMinutes)) {
                    String message = String.format(
                        "%s = %.4g — anlık %.0f%% degisim (yeni instance, henuz yeterli gecmis veri yok)",
                        metricName, current.doubleValue(), fallbackChange.doubleValue());
                    Map<String, Object> ctx = baseContext(rule, instancePk, "warning");
                    ctx.put("value", current);
                    ctx.put("previous_value", prev);
                    ctx.put("change_pct", fallbackChange);
                    ctx.put("threshold", spikeFallbackPct);
                    String[] rendered = buildAlertText(rule, ruleName, message, ctx);
                    alertRepo.upsertWithSeverity(alertKey, AlertCode.USER_DEFINED_RULE,
                        "warning", instancePk, serviceGroup, rendered[0], rendered[1], ruleId);
                    updateLastEval(ruleId, instancePk, current, "warning");
                } else {
                    updateLastEval(ruleId, instancePk, current, null);
                }
                continue;
            }

            // Yeterli veri var: bu saatin (hour_of_week) 4 haftalik baseline ortalamasini kullan.
            // Baseline'i once alert_rule_last_eval'dan oku, haftalik guncelle.
            BigDecimal baseline = getOrRefreshBaseline(ruleId, instancePk, metricType, metricName, aggFn);
            if (baseline == null || baseline.compareTo(BigDecimal.ZERO) == 0) {
                updateLastEval(ruleId, instancePk, current, null);
                continue;
            }

            BigDecimal changePct = computeChangePct(current, baseline);

            if (isInCooldown(ruleId, instancePk, cooldownMinutes)) {
                updateLastEval(ruleId, instancePk, changePct, null);
                continue;
            }

            String prevSeverity = getPrevSeverity(ruleId, instancePk);
            boolean triggered = changePct.compareTo(changeThresholdPct) > 0;

            if (triggered) {
                String severity = changePct.compareTo(changeThresholdPct.multiply(new BigDecimal("2"))) > 0
                    ? "critical" : "warning";
                String message = String.format(
                    "%s = %.4g — bu saatin 4 haftalik ortalamasindan (%.4g) %.0f%% sapma (esik: %.0f%%)",
                    metricName, current.doubleValue(), baseline.doubleValue(),
                    changePct.doubleValue(), changeThresholdPct.doubleValue());
                Map<String, Object> ctx = baseContext(rule, instancePk, severity);
                ctx.put("value", current);
                ctx.put("baseline_avg", baseline);
                ctx.put("change_pct", changePct);
                ctx.put("threshold", changeThresholdPct);
                String[] rendered = buildAlertText(rule, ruleName, message, ctx);

                // Granular tipte: en cok katki yapan record'lari detail JSON'a
                String detailsJson = null;
                if (isGranularMetricType(metricType)) {
                    List<Map<String, Object>> contributors = findRecordsTopContributors(
                        instancePk, metricType, metricName, windowMinutes, true);
                    if (!contributors.isEmpty()) {
                        detailsJson = buildPerRecordsJson(contributors, metricType, windowMinutes,
                            baseline.toPlainString(), "hourly_pattern_top_contributors");
                    }
                }

                if (detailsJson != null) {
                    alertRepo.upsert(alertKey, AlertCode.USER_DEFINED_RULE,
                        instancePk, serviceGroup, null, rendered[0], rendered[1], detailsJson);
                    jdbc.update("update ops.alert set severity = ? where alert_key = ?", severity, alertKey);
                } else {
                    alertRepo.upsertWithSeverity(alertKey, AlertCode.USER_DEFINED_RULE,
                        severity, instancePk, serviceGroup, rendered[0], rendered[1], ruleId);
                }
                updateLastEval(ruleId, instancePk, changePct, severity);
            } else if (prevSeverity != null && autoResolve) {
                alertRepo.resolve(alertKey);
                updateLastEval(ruleId, instancePk, changePct, null);
            } else {
                updateLastEval(ruleId, instancePk, changePct, null);
            }
        }
    }

    // =========================================================================
    // Baseline: haftalik ortalama hesaplama ve cache
    // =========================================================================

    /**
     * Bu instance + kural icin baseline degerini doner.
     * Baseline yoksa veya BASELINE_UPDATE_DAYS gun gectiyse yeniden hesaplar.
     * Baseline: son 4 haftada ayni hour_of_week icin metrigin ortalamasi.
     */
    private BigDecimal getOrRefreshBaseline(long ruleId, long instancePk,
                                             String metricType, String metricName, String aggFn) {
        try {
            Map<String, Object> evalRow = jdbc.queryForMap(
                "select baseline_value, baseline_updated_at" +
                " from control.alert_rule_last_eval" +
                " where rule_id = ? and instance_pk = ?",
                ruleId, instancePk);

            BigDecimal cachedBaseline = toBDSafe(evalRow.get("baseline_value"));
            Object updatedAt = evalRow.get("baseline_updated_at");

            // Baseline guncel mi? (BASELINE_UPDATE_DAYS gunden eski degilse kullan)
            if (cachedBaseline != null && updatedAt != null) {
                boolean isStale = jdbc.queryForObject(
                    "select ? < now() - interval '" + BASELINE_UPDATE_DAYS + " days'",
                    Boolean.class, updatedAt);
                if (!Boolean.TRUE.equals(isStale)) return cachedBaseline;
            }

            // Hesapla: son 4 hafta, ayni day_of_week + hour_of_day grubunda ortalama
            BigDecimal freshBaseline = computeHourlyBaseline(metricType, metricName, aggFn, instancePk);
            if (freshBaseline != null) {
                jdbc.update(
                    "update control.alert_rule_last_eval" +
                    " set baseline_value = ?, baseline_updated_at = now()" +
                    " where rule_id = ? and instance_pk = ?",
                    freshBaseline, ruleId, instancePk);
            }
            return freshBaseline;

        } catch (Exception e) {
            // Satir henuz yok — hesapla, updateLastEval sonra kaydeder
            return computeHourlyBaseline(metricType, metricName, aggFn, instancePk);
        }
    }

    private BigDecimal computeHourlyBaseline(String metricType, String metricName,
                                              String aggFn, long instancePk) {
        String table = getMetricTable(metricType);
        String timeCol = getTimeColumn(metricType);
        if (table == null) return null;

        // Ayni metrik mevcut degeri icin kolon adi
        String col = getSimpleColumn(metricType, metricName);
        if (col == null) return null; // derived metrikler icin simdilik desteklenmez

        try {
            // Son 4 hafta, simdiyle ayni hour_of_week (Mon=0..Sun=6, hour=0..23)
            return jdbc.queryForObject(
                "select avg(hourly_val) from (" +
                "  select " + aggFn + "(" + col + ") as hourly_val" +
                "  from " + table +
                "  where instance_pk = ?" +
                "    and " + timeCol + " >= now() - interval '4 weeks'" +
                "    and extract(dow from " + timeCol + ") = extract(dow from now())" +
                "    and extract(hour from " + timeCol + ") = extract(hour from now())" +
                "  group by date_trunc('hour', " + timeCol + ")" +
                ") sub",
                BigDecimal.class, instancePk);
        } catch (Exception e) {
            log.debug("Baseline hesaplama hatasi metric={}.{}: {}", metricType, metricName, e.getMessage());
            return null;
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
            case "wal_metric"         -> queryWalMetric(metricName, aggFn, interval);
            case "archiver_metric"    -> queryArchiverMetric(metricName, aggFn, interval);
            case "slot_metric"        -> querySlotMetric(metricName, aggFn, interval);
            case "conflict_metric"    -> queryConflictMetric(metricName, aggFn, interval);
            case "slru_metric"        -> querySnapshotMetric("fact.pg_slru_snapshot", metricName, aggFn, interval);
            case "subscription_metric"-> querySnapshotMetric("fact.pg_subscription_snapshot", metricName, aggFn, interval);
            case "prefetch_metric"    -> querySnapshotMetric("fact.pg_recovery_prefetch_snapshot", metricName, aggFn, interval);
            case "function_metric"    -> querySnapshotMetric("fact.pg_user_function_snapshot", metricName, aggFn, interval);
            case "sequence_metric"    -> querySnapshotMetric("fact.pg_sequence_io_snapshot", metricName, aggFn, interval);
            default -> { log.warn("Desteklenmeyen metric_type: {}", metricType); yield List.of(); }
        };
    }

    /**
     * N gun onceki ayni penceredeki degeri sorgular.
     * daysBack=0 ise spike icin onceki pencere: 2*window .. 1*window once.
     */
    private List<Map<String, Object>> queryMetricAtOffset(String metricType, String metricName,
                                                           String aggFn, int windowMinutes, int daysBack) {
        String intervalStart, intervalEnd;
        if (daysBack == 0) {
            // Spike: onceki non-overlapping pencere
            intervalStart = (windowMinutes * 2) + " minutes";
            intervalEnd   = windowMinutes + " minutes";
        } else {
            intervalStart = (daysBack * 24 * 60 + windowMinutes) + " minutes";
            intervalEnd   = (daysBack * 24 * 60) + " minutes";
        }

        return switch (metricType) {
            case "cluster_metric"     -> queryClusterMetricBetween(metricName, aggFn, intervalStart, intervalEnd);
            case "database_metric"    -> queryDatabaseMetricBetween(metricName, aggFn, intervalStart, intervalEnd);
            case "activity_metric"    -> queryActivityMetricBetween(metricName, intervalStart, intervalEnd);
            case "replication_metric" -> queryReplicationMetricBetween(metricName, aggFn, intervalStart, intervalEnd);
            case "statement_metric"   -> queryStatementMetricBetween(metricName, aggFn, intervalStart, intervalEnd);
            case "table_metric"       -> queryTableMetricBetween(metricName, aggFn, intervalStart, intervalEnd);
            case "wal_metric"         -> queryWalMetricBetween(metricName, aggFn, intervalStart, intervalEnd);
            case "archiver_metric"    -> queryArchiverMetricBetween(metricName, aggFn, intervalStart, intervalEnd);
            case "slot_metric"        -> querySlotMetricBetween(metricName, aggFn, intervalStart, intervalEnd);
            case "conflict_metric"    -> queryConflictMetricBetween(metricName, aggFn, intervalStart, intervalEnd);
            case "slru_metric"        -> querySnapshotMetricBetween("fact.pg_slru_snapshot", metricName, aggFn, intervalStart, intervalEnd);
            case "subscription_metric"-> querySnapshotMetricBetween("fact.pg_subscription_snapshot", metricName, aggFn, intervalStart, intervalEnd);
            case "prefetch_metric"    -> querySnapshotMetricBetween("fact.pg_recovery_prefetch_snapshot", metricName, aggFn, intervalStart, intervalEnd);
            case "function_metric"    -> querySnapshotMetricBetween("fact.pg_user_function_snapshot", metricName, aggFn, intervalStart, intervalEnd);
            case "sequence_metric"    -> querySnapshotMetricBetween("fact.pg_sequence_io_snapshot", metricName, aggFn, intervalStart, intervalEnd);
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
        String tableSql = getMetricTableAndColumn(metricType, metricName);
        if (tableSql == null) return null;
        String[] parts = tableSql.split("\\|");
        try {
            return jdbc.queryForObject(
                "select " + extremeFn + "(computed_value) from (" +
                "  select " + aggFn + "(" + parts[1] + ") as computed_value" +
                "  from " + parts[0] +
                "  where instance_pk = ?" +
                "    and " + parts[2] + " < now() - ?::interval" +
                "  group by date_trunc('hour', " + parts[2] + ")" +
                ") sub",
                BigDecimal.class, instancePk, excludeLastMinutes + " minutes");
        } catch (Exception e) {
            log.debug("Tarihi extreme sorgu hatasi metric={}: {}", metricName, e.getMessage());
            return null;
        }
    }

    /**
     * Metrik tipi icin "tablo|kolon|zaman_kolonu" formatinda meta doner.
     */
    private String getMetricTableAndColumn(String metricType, String metricName) {
        return switch (metricType + "." + metricName) {
            case "cluster_metric.wal_bytes"              -> "fact.pg_cluster_delta|wal_bytes|sample_ts";
            case "cluster_metric.checkpoint_write_time"  -> "fact.pg_cluster_delta|checkpoint_write_time|sample_ts";
            case "cluster_metric.buffers_checkpoint"     -> "fact.pg_cluster_delta|buffers_checkpoint|sample_ts";
            case "cluster_metric.checkpoints_timed"      -> "fact.pg_cluster_delta|checkpoints_timed|sample_ts";
            case "database_metric.deadlocks"             -> "fact.pg_database_delta|deadlocks_delta|sample_ts";
            case "database_metric.temp_files"            -> "fact.pg_database_delta|temp_files_delta|sample_ts";
            case "database_metric.blk_read_time"         -> "fact.pg_database_delta|blk_read_time_delta|sample_ts";
            case "database_metric.autovacuum_count"      -> "fact.pg_database_delta|autovacuum_count_delta|sample_ts";
            case "database_metric.db_size_bytes"         -> "fact.pg_database_delta|db_size_bytes|sample_ts";
            case "replication_metric.replay_lag_bytes"   -> "fact.pg_replication_snapshot|replay_lag_bytes|snapshot_ts";
            case "statement_metric.calls"                -> "fact.pgss_delta|calls_delta|sample_ts";
            case "statement_metric.temp_blks_written"    -> "fact.pgss_delta|temp_blks_written_delta|sample_ts";
            case "table_metric.seq_scan"                 -> "fact.pg_table_stat_delta|seq_scan_delta|sample_ts";
            // WAL metrikleri (V023)
            case "wal_metric.period_wal_size_byte"       -> "fact.pg_wal_snapshot|period_wal_size_byte|sample_ts";
            case "wal_metric.wal_directory_size_byte"    -> "fact.pg_wal_snapshot|wal_directory_size_byte|sample_ts";
            case "wal_metric.wal_file_count"             -> "fact.pg_wal_snapshot|wal_file_count|sample_ts";
            // Archiver metrikleri (V023)
            case "archiver_metric.archived_count"        -> "fact.pg_archiver_snapshot|archived_count|sample_ts";
            case "archiver_metric.failed_count"          -> "fact.pg_archiver_snapshot|failed_count|sample_ts";
            // Replication slot (V024)
            case "slot_metric.slot_lag_bytes"            -> "fact.pg_replication_slot_snapshot|slot_lag_bytes|sample_ts";
            case "slot_metric.spill_bytes"               -> "fact.pg_replication_slot_snapshot|spill_bytes|sample_ts";
            // Standby conflicts (V024)
            case "conflict_metric.confl_tablespace"      -> "fact.pg_database_conflict_snapshot|confl_tablespace|sample_ts";
            case "conflict_metric.confl_lock"            -> "fact.pg_database_conflict_snapshot|confl_lock|sample_ts";
            case "conflict_metric.confl_snapshot"        -> "fact.pg_database_conflict_snapshot|confl_snapshot|sample_ts";
            case "conflict_metric.confl_bufferpin"       -> "fact.pg_database_conflict_snapshot|confl_bufferpin|sample_ts";
            case "conflict_metric.confl_deadlock"        -> "fact.pg_database_conflict_snapshot|confl_deadlock|sample_ts";
            // SLRU (V026)
            case "slru_metric.blks_read"                 -> "fact.pg_slru_snapshot|blks_read|sample_ts";
            case "slru_metric.blks_hit"                  -> "fact.pg_slru_snapshot|blks_hit|sample_ts";
            case "slru_metric.blks_written"              -> "fact.pg_slru_snapshot|blks_written|sample_ts";
            // Subscription (V026)
            case "subscription_metric.apply_error_count" -> "fact.pg_subscription_snapshot|apply_error_count|sample_ts";
            case "subscription_metric.sync_error_count"  -> "fact.pg_subscription_snapshot|sync_error_count|sample_ts";
            case "subscription_metric.lag_bytes"         -> "fact.pg_subscription_snapshot|lag_bytes|sample_ts";
            // Recovery prefetch (V026)
            case "prefetch_metric.prefetch"              -> "fact.pg_recovery_prefetch_snapshot|prefetch|sample_ts";
            case "prefetch_metric.hit"                   -> "fact.pg_recovery_prefetch_snapshot|hit|sample_ts";
            case "prefetch_metric.skip_fpw"              -> "fact.pg_recovery_prefetch_snapshot|skip_fpw|sample_ts";
            // User functions (V026)
            case "function_metric.calls"                 -> "fact.pg_user_function_snapshot|calls|sample_ts";
            case "function_metric.total_time"            -> "fact.pg_user_function_snapshot|total_time|sample_ts";
            case "function_metric.self_time"             -> "fact.pg_user_function_snapshot|self_time|sample_ts";
            // Sequence I/O (V028)
            case "sequence_metric.blks_read"             -> "fact.pg_sequence_io_snapshot|blks_read|sample_ts";
            case "sequence_metric.blks_hit"              -> "fact.pg_sequence_io_snapshot|blks_hit|sample_ts";
            default -> null;
        };
    }

    /** Baseline icin basit kolon adi (derived metrikler null doner). */
    private String getSimpleColumn(String metricType, String metricName) {
        String tableSql = getMetricTableAndColumn(metricType, metricName);
        if (tableSql == null) return null;
        return tableSql.split("\\|")[1];
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
            case "wal_metric"         -> "fact.pg_wal_snapshot";
            case "archiver_metric"    -> "fact.pg_archiver_snapshot";
            case "slot_metric"        -> "fact.pg_replication_slot_snapshot";
            case "conflict_metric"    -> "fact.pg_database_conflict_snapshot";
            case "slru_metric"        -> "fact.pg_slru_snapshot";
            case "subscription_metric"-> "fact.pg_subscription_snapshot";
            case "prefetch_metric"    -> "fact.pg_recovery_prefetch_snapshot";
            case "function_metric"    -> "fact.pg_user_function_snapshot";
            case "sequence_metric"    -> "fact.pg_sequence_io_snapshot";
            default -> null;
        };
    }

    private String getTimeColumn(String metricType) {
        return "activity_metric".equals(metricType) || "replication_metric".equals(metricType)
            ? "snapshot_ts" : "sample_ts";
    }

    // =========================================================================
    // Metrik sorgulama — mevcut pencere (tip bazinda)
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
            "select instance_pk, " + aggFn + "(" + toFactColumn(metricName, "database_metric") + ") as value" +
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
            "select instance_pk, " + aggFn + "(" + toFactColumn(metricName, "replication_metric") + ") as value" +
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
            "select instance_pk, " + aggFn + "(" + toFactColumn(metricName, "statement_metric") + ") as value" +
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
            "select instance_pk, " + aggFn + "(" + toFactColumn(metricName, "table_metric") + ") as value" +
            " from fact.pg_table_stat_delta where sample_ts >= now() - ?::interval group by instance_pk",
            interval);
    }

    // =========================================================================
    // Metrik sorgulama — gecmis pencere (trend / spike icin)
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
            "select instance_pk, " + aggFn + "(" + toFactColumn(metricName, "database_metric") + ") as value" +
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
            "select instance_pk, " + aggFn + "(" + toFactColumn(metricName, "replication_metric") + ") as value" +
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
            "select instance_pk, " + aggFn + "(" + toFactColumn(metricName, "statement_metric") + ") as value" +
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
            "select instance_pk, " + aggFn + "(" + toFactColumn(metricName, "table_metric") + ") as value" +
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
                   instance_pk, service_group, instance_group_id,
                   condition_operator, warning_threshold, critical_threshold,
                   evaluation_window_minutes, aggregation,
                   evaluation_type, change_threshold_pct, min_data_days,
                   alert_category, spike_fallback_pct, flatline_minutes,
                   sensitivity, cooldown_minutes, auto_resolve
            from control.alert_rule
            where is_enabled = true
            order by rule_id
            """);
    }

    private List<Map<String, Object>> loadTargetInstances(Map<String, Object> rule) {
        String scope = (String) rule.get("scope");
        Long instancePk = rule.get("instance_pk") != null ? toLong(rule.get("instance_pk")) : null;
        String serviceGroup = (String) rule.get("service_group");
        Long instanceGroupId = rule.get("instance_group_id") != null ? toLong(rule.get("instance_group_id")) : null;
        long ruleId = toLong(rule.get("rule_id"));
        String metricKey = ((String) rule.get("metric_type")).replace("_metric", "") + "." + rule.get("metric_name");

        List<Map<String, Object>> targets = switch (scope != null ? scope : "all_instances") {
            case "specific_instance" -> jdbc.queryForList(
                "select instance_pk, service_group from control.instance_inventory" +
                " where instance_pk = ? and is_active = true", instancePk);
            case "service_group" -> jdbc.queryForList(
                "select instance_pk, service_group from control.instance_inventory" +
                " where service_group = ? and is_active = true", serviceGroup);
            case "instance_group" -> instanceGroupId == null ? List.<Map<String, Object>>of()
                : jdbc.queryForList(
                    "select i.instance_pk, i.service_group from control.instance_inventory i" +
                    " join control.instance_group_member m on m.instance_pk = i.instance_pk" +
                    " where m.group_id = ? and i.is_active = true", instanceGroupId);
            default -> jdbc.queryForList(
                "select instance_pk, service_group from control.instance_inventory where is_active = true");
        };

        // Snooze / maintenance filtresi
        if (targets.isEmpty()) return targets;
        List<Map<String, Object>> filtered = new java.util.ArrayList<>(targets.size());
        for (Map<String, Object> t : targets) {
            long pk = toLong(t.get("instance_pk"));
            if (isSnoozed(ruleId, pk, metricKey)) {
                log.debug("Alert snoozed rule={} instance={} metric={}", ruleId, pk, metricKey);
                continue;
            }
            if (isInMaintenance(pk)) {
                log.debug("Instance in maintenance rule={} instance={}", ruleId, pk);
                continue;
            }
            filtered.add(t);
        }
        return filtered;
    }

    private boolean isSnoozed(long ruleId, long instancePk, String metricKey) {
        try {
            Boolean r = jdbc.queryForObject(
                "select control.is_alert_snoozed(?::int, ?::bigint, ?, null::bigint)",
                Boolean.class, (int) ruleId, instancePk, metricKey);
            return Boolean.TRUE.equals(r);
        } catch (Exception e) {
            return false;
        }
    }

    private boolean isInMaintenance(long instancePk) {
        try {
            Boolean r = jdbc.queryForObject(
                "select control.is_in_maintenance(?)", Boolean.class, instancePk);
            return Boolean.TRUE.equals(r);
        } catch (Exception e) {
            return false;
        }
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

    /** current ve past arasindaki mutlak % degisim. past=0 ise 999999 doner. */
    private BigDecimal computeChangePct(BigDecimal current, BigDecimal past) {
        if (past.compareTo(BigDecimal.ZERO) == 0) {
            return current.compareTo(BigDecimal.ZERO) > 0
                ? new BigDecimal("999999") : BigDecimal.ZERO;
        }
        return current.subtract(past)
            .divide(past.abs(), 4, RoundingMode.HALF_UP)
            .multiply(new BigDecimal("100"))
            .abs();
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
        if (severity != null) {
            jdbc.update("""
                insert into control.alert_rule_last_eval
                  (rule_id, instance_pk, last_evaluated_at, last_alert_at, last_value, current_severity)
                values (?, ?, now(), now(), ?, ?)
                on conflict (rule_id, instance_pk) do update set
                  last_evaluated_at = now(),
                  last_alert_at = now(),
                  last_value = excluded.last_value,
                  current_severity = excluded.current_severity
                """,
                ruleId, instancePk, value, severity);
        } else {
            jdbc.update("""
                insert into control.alert_rule_last_eval
                  (rule_id, instance_pk, last_evaluated_at, last_value, current_severity)
                values (?, ?, now(), ?, null)
                on conflict (rule_id, instance_pk) do update set
                  last_evaluated_at = now(),
                  last_value = excluded.last_value,
                  current_severity = null
                """,
                ruleId, instancePk, value);
        }
    }

    private String buildThresholdMessage(String metricName, BigDecimal value, String operator,
                                          BigDecimal threshold, int windowMinutes, String aggregation) {
        return String.format("%s = %.4g (esik: %s %.4g, son %d dk %s)",
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

    /**
     * UI'daki metric_name'i fact tablosundaki kolon adina cevirir.
     * Ornek: "calls" → "calls_delta", "temp_blks_written" → "temp_blks_written_delta"
     * Zaten _delta ile bitiyorsa dokunmaz.
     */
    private String toFactColumn(String metricName, String metricType) {
        String safe = sanitizeCol(metricName);
        // Snapshot tablolari delta suffix kullanmaz
        if ("activity_metric".equals(metricType) || "replication_metric".equals(metricType)) {
            return safe;
        }
        // Cluster metric: metric_value_num kullanir, kolon adi degil
        if ("cluster_metric".equals(metricType)) {
            return safe;
        }
        // Zaten _delta ile bitiyorsa dokunma
        if (safe.endsWith("_delta")) return safe;
        // Gauge metrikler (estimate, ratio vb.) delta suffix almaz
        if (safe.endsWith("_estimate") || safe.endsWith("_ratio") || safe.equals("numbackends")) {
            return safe;
        }
        return safe + "_delta";
    }

    private long toLong(Object v) { return ((Number) v).longValue(); }
    private int  toInt(Object v)  { return v != null ? ((Number) v).intValue() : 0; }
    private BigDecimal toBD(Object v)     { return v instanceof BigDecimal bd ? bd : null; }
    private BigDecimal toBDSafe(Object v) {
        if (v == null) return null;
        if (v instanceof BigDecimal bd) return bd;
        try { return new BigDecimal(v.toString()); } catch (Exception e) { return null; }
    }

    // =========================================================================
    // WAL / Archiver / Slot / Conflict metrik sorgulari
    // =========================================================================

    private List<Map<String, Object>> queryWalMetric(String metricName, String aggFn, String interval) {
        String col = sanitizeCol(metricName);
        return jdbc.queryForList(
            "select instance_pk, " + aggFn + "(" + col + ") as value" +
            " from fact.pg_wal_snapshot where sample_ts >= now() - ?::interval group by instance_pk",
            interval);
    }

    private List<Map<String, Object>> queryWalMetricBetween(String metricName, String aggFn,
                                                              String intervalStart, String intervalEnd) {
        String col = sanitizeCol(metricName);
        return jdbc.queryForList(
            "select instance_pk, " + aggFn + "(" + col + ") as value" +
            " from fact.pg_wal_snapshot" +
            " where sample_ts between now() - ?::interval and now() - ?::interval group by instance_pk",
            intervalStart, intervalEnd);
    }

    private List<Map<String, Object>> queryArchiverMetric(String metricName, String aggFn, String interval) {
        // Archiver cumulative — max alir son deger. Ancak "artis var mi" icin
        // once - sonra delta hesaplamak lazim. Burada max kullaniyoruz.
        String col = sanitizeCol(metricName);
        return jdbc.queryForList(
            "select instance_pk, " + aggFn + "(" + col + ") as value" +
            " from fact.pg_archiver_snapshot where sample_ts >= now() - ?::interval group by instance_pk",
            interval);
    }

    private List<Map<String, Object>> queryArchiverMetricBetween(String metricName, String aggFn,
                                                                    String intervalStart, String intervalEnd) {
        String col = sanitizeCol(metricName);
        return jdbc.queryForList(
            "select instance_pk, " + aggFn + "(" + col + ") as value" +
            " from fact.pg_archiver_snapshot" +
            " where sample_ts between now() - ?::interval and now() - ?::interval group by instance_pk",
            intervalStart, intervalEnd);
    }

    private List<Map<String, Object>> querySlotMetric(String metricName, String aggFn, String interval) {
        String col = sanitizeCol(metricName);
        return jdbc.queryForList(
            "select instance_pk, " + aggFn + "(" + col + ") as value" +
            " from fact.pg_replication_slot_snapshot where sample_ts >= now() - ?::interval group by instance_pk",
            interval);
    }

    private List<Map<String, Object>> querySlotMetricBetween(String metricName, String aggFn,
                                                                String intervalStart, String intervalEnd) {
        String col = sanitizeCol(metricName);
        return jdbc.queryForList(
            "select instance_pk, " + aggFn + "(" + col + ") as value" +
            " from fact.pg_replication_slot_snapshot" +
            " where sample_ts between now() - ?::interval and now() - ?::interval group by instance_pk",
            intervalStart, intervalEnd);
    }

    private List<Map<String, Object>> queryConflictMetric(String metricName, String aggFn, String interval) {
        String col = sanitizeCol(metricName);
        return jdbc.queryForList(
            "select instance_pk, " + aggFn + "(" + col + ") as value" +
            " from fact.pg_database_conflict_snapshot where sample_ts >= now() - ?::interval group by instance_pk",
            interval);
    }

    private List<Map<String, Object>> queryConflictMetricBetween(String metricName, String aggFn,
                                                                    String intervalStart, String intervalEnd) {
        String col = sanitizeCol(metricName);
        return jdbc.queryForList(
            "select instance_pk, " + aggFn + "(" + col + ") as value" +
            " from fact.pg_database_conflict_snapshot" +
            " where sample_ts between now() - ?::interval and now() - ?::interval group by instance_pk",
            intervalStart, intervalEnd);
    }

    // Generic snapshot table query — SLRU, subscription, prefetch, function icin
    private List<Map<String, Object>> querySnapshotMetric(String table, String metricName,
                                                           String aggFn, String interval) {
        String col = sanitizeCol(metricName);
        return jdbc.queryForList(
            "select instance_pk, " + aggFn + "(" + col + ") as value" +
            " from " + table + " where sample_ts >= now() - ?::interval group by instance_pk",
            interval);
    }

    private List<Map<String, Object>> querySnapshotMetricBetween(String table, String metricName,
                                                                   String aggFn, String intervalStart, String intervalEnd) {
        String col = sanitizeCol(metricName);
        return jdbc.queryForList(
            "select instance_pk, " + aggFn + "(" + col + ") as value" +
            " from " + table +
            " where sample_ts between now() - ?::interval and now() - ?::interval group by instance_pk",
            intervalStart, intervalEnd);
    }
}
