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

    private record TempRuleDetails(
        String detailsJson,
        String messageSuffix,
        String workMem,
        String suggestedWorkMem,
        String topQueriesText
    ) {}

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
        String metricName = (String) rule.get("metric_name");
        String metricType = (String) rule.get("metric_type");
        String evalType   = rule.get("evaluation_type") != null ? (String) rule.get("evaluation_type") : "threshold";
        ctx.put("metric", metricName);
        ctx.put("metric_type", metricType);
        ctx.put("aggregation", rule.get("aggregation"));
        ctx.put("operator", rule.get("condition_operator"));
        ctx.put("window", rule.get("evaluation_window_minutes"));
        ctx.put("warning_threshold", rule.get("warning_threshold"));
        ctx.put("critical_threshold", rule.get("critical_threshold"));
        ctx.put("severity", severity);
        ctx.put("instance_pk", instancePk);
        ctx.put("instance", lookupInstanceName(instancePk));
        // Kullanıcıya anlamlı Türkçe açıklamalar
        ctx.put("metric_description", getMetricDescription(metricType, metricName));
        ctx.put("eval_description", getEvalDescription(evalType));
        return ctx;
    }

    /**
     * Metrik adını kullanıcıya anlamlı Türkçe açıklamaya çevirir.
     * Alert mesajlarında {{metric_description}} olarak kullanılır.
     */
    private static String getMetricDescription(String metricType, String metricName) {
        String key = metricType + "." + metricName;
        return switch (key) {
            // Statement metrikleri
            case "statement_metric.calls"                -> "Sorgu çağrı sayısı (pg_stat_statements). Bir sorgunun kaç kez çalıştırıldığı.";
            case "statement_metric.avg_exec_time_ms"     -> "Ortalama sorgu çalışma süresi (ms). Yavaşlayan sorgular bu değeri artırır.";
            case "statement_metric.temp_blks_written"    -> "Geçici blok yazımı. work_mem yetersizse sorgular diske geçici dosya yazar — performansı düşürür.";
            case "statement_metric.total_exec_time_ms"   -> "Toplam sorgu çalışma süresi (ms). Tüm çağrıların toplam süresi.";
            case "statement_metric.rows"                 -> "Sorgunun döndürdüğü/etkilediği satır sayısı.";
            case "statement_metric.shared_blks_read"     -> "Diskten okunan paylaşımlı blok sayısı. Yüksekse cache miss var, shared_buffers yetersiz olabilir.";
            // Cluster metrikleri
            case "cluster_metric.cache_hit_ratio"        -> "Buffer cache isabet oranı (%). Düşükse sorgular diske gidiyor, shared_buffers artırılmalı.";
            case "cluster_metric.wal_bytes"              -> "WAL (Write-Ahead Log) üretimi (byte). Yüksekse yoğun yazma işlemi var.";
            case "cluster_metric.checkpoint_write_time"   -> "Checkpoint yazma süresi (ms). Uzunsa disk I/O yavaş veya checkpoint_completion_target düşük.";
            case "cluster_metric.buffers_checkpoint"     -> "Checkpoint sırasında yazılan buffer sayısı.";
            case "cluster_metric.buffers_clean"          -> "Background writer tarafından temizlenen buffer sayısı.";
            // Activity metrikleri
            case "activity_metric.active_count"          -> "Aktif sorgu çalıştıran bağlantı sayısı. Yüksekse CPU/IO baskısı olabilir.";
            case "activity_metric.idle_in_transaction_count" -> "Transaction açık bekleyen bağlantı sayısı. Uzun süre açık kalırsa lock ve bloat sorunlarına yol açar.";
            case "activity_metric.waiting_count"         -> "Kilit bekleyen bağlantı sayısı. Lock contention var demektir.";
            // Database metrikleri
            case "database_metric.deadlocks"             -> "Deadlock sayısı. İki veya daha fazla transaction birbirini bekliyor, biri otomatik iptal edildi.";
            case "database_metric.temp_files"            -> "Oluşturulan geçici dosya sayısı. work_mem yetersizse sorgular diske taşar.";
            case "database_metric.blk_read_time"         -> "Toplam disk okuma süresi (ms). track_io_timing aktifse ölçülür.";
            case "database_metric.rollback_ratio"        -> "Rollback oranı (%). Yüksekse uygulama hataları veya retry storm olabilir.";
            // Replication
            case "replication_metric.replay_lag_bytes"   -> "Replikasyon gecikmesi (byte). Standby, primary'den ne kadar geride.";
            case "replication_metric.replay_lag_seconds"  -> "Replikasyon gecikmesi (saniye).";
            // Table metrikleri
            case "table_metric.dead_tuple_ratio"         -> "Ölü satır oranı (%). Yüksekse VACUUM gerekli, tablo şişmiş olabilir.";
            case "table_metric.seq_scan"                 -> "Sequential scan sayısı. Yüksekse eksik index olabilir.";
            case "table_metric.n_tup_ins"                -> "INSERT sayısı. Yoğun veri girişi var.";
            // WAL
            case "wal_metric.period_wal_size_byte"       -> "İki ölçüm arasında üretilen WAL miktarı (byte).";
            case "wal_metric.wal_directory_size_byte"     -> "pg_wal dizininin toplam boyutu. Yüksekse archiver geride kalmış olabilir.";
            case "wal_metric.wal_file_count"             -> "WAL dosya sayısı. Çok fazlaysa archiver veya replication geride.";
            // Archiver
            case "archiver_metric.failed_count"          -> "Archive başarısız sayısı. archive_command hata veriyor.";
            case "archiver_metric.archived_count"        -> "Başarıyla archive edilen WAL dosya sayısı.";
            // Slot
            case "slot_metric.slot_lag_bytes"            -> "Replication slot gecikmesi (byte). Yüksekse WAL dosyaları birikir, disk dolar.";
            // SLRU
            case "slru_metric.blks_read"                 -> "SLRU cache miss — diskten okunan blok. Yüksekse performans etkilenir.";
            // Function
            case "function_metric.calls"                 -> "Fonksiyon çağrı sayısı (pg_stat_user_functions).";
            case "function_metric.total_time"            -> "Fonksiyonun toplam çalışma süresi (ms).";
            default -> metricType.replace("_metric", "") + " · " + metricName;
        };
    }

    /** Evaluation type'ı kullanıcıya anlamlı Türkçe açıklamaya çevirir. */
    private static String getEvalDescription(String evalType) {
        return switch (evalType) {
            case "threshold"      -> "Sabit eşik karşılaştırması";
            case "spike"          -> "Önceki döneme göre ani artış tespiti";
            case "flatline"       -> "Değer belirli süre hiç değişmedi";
            case "day_over_day"   -> "Dünün aynı saatine göre değişim";
            case "week_over_week" -> "Geçen haftanın aynı gününe göre değişim";
            case "alltime_high"   -> "Tüm zamanların en yüksek değeri aşıldı";
            case "alltime_low"    -> "Tüm zamanların en düşük değerinin altına düşüldü";
            case "hourly_pattern" -> "Bu saatin 4 haftalık ortalamasından sapma";
            case "adaptive"       -> "28 günlük baseline üzerinden otomatik eşik";
            default -> evalType;
        };
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
        String metricType = (String) rule.get("metric_type");

        // Granular tip (statement/table/index) ise per-record adaptive eval'a dallan
        // Her sorgu/tablo/index icin ayri baseline karsilastirmasi yapar
        if (isGranularMetricType(metricType)) {
            evaluateAdaptivePerRecord(rule);
            return;
        }

        long ruleId = toLong(rule.get("rule_id"));
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

        // UTC kullan — container TZ'na bağımlı olmasın (baseline'lar UTC saatte tutulur)
        int currentHour = java.time.OffsetDateTime.now(java.time.ZoneOffset.UTC).getHour();

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
                TempRuleDetails tempDetails = null;
                if ("statement_metric".equals(metricType)) {
                    detailsJson = buildTopQueryDetails(instancePk, metricName, windowMinutes,
                        avg, upperWarning, upperCritical, currentHour, sensitivity);
                } else if (isDatabaseTempFilesRule(metricType, metricName)) {
                    tempDetails = buildTempFileRuleDetails(instancePk, windowMinutes,
                        avg, upperWarning, upperCritical, currentHour, sensitivity);
                    if (tempDetails != null) {
                        detailsJson = tempDetails.detailsJson();
                    }
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
                if (tempDetails != null) {
                    ctx.put("work_mem", tempDetails.workMem());
                    ctx.put("suggested_work_mem", tempDetails.suggestedWorkMem());
                    ctx.put("top_temp_queries", tempDetails.topQueriesText());
                }
                String[] rendered = buildAlertText(rule, ruleName, message, ctx);
                if (tempDetails != null && !tempDetails.messageSuffix().isBlank()) {
                    rendered[1] = rendered[1] + "\n\n" + tempDetails.messageSuffix();
                }

                if (detailsJson != null) {
                    alertRepo.upsertWithSeverity(alertKey, AlertCode.USER_DEFINED_RULE,
                        severity, instancePk, serviceGroup, rendered[0], rendered[1],
                        ruleId, detailsJson);
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

    private boolean isDatabaseTempFilesRule(String metricType, String metricName) {
        return "database_metric".equals(metricType) && "temp_files".equals(metricName);
    }

    private TempRuleDetails buildTempFileRuleDetails(long instancePk, int windowMinutes,
                                                      BigDecimal baselineAvg,
                                                      BigDecimal warningThreshold,
                                                      BigDecimal criticalThreshold,
                                                      int hour, String sensitivity) {
        try {
            Map<String, Object> workMemRow = null;
            try {
                List<Map<String, Object>> rows = jdbc.queryForList("""
                    select setting_value, unit
                    from fact.pg_settings_snapshot
                    where instance_pk = ? and setting_name = 'work_mem'
                    order by snapshot_ts desc
                    limit 1
                    """, instancePk);
                if (!rows.isEmpty()) {
                    workMemRow = rows.get(0);
                }
            } catch (Exception ignore) {}
            Map<String, Object> maxConnectionsRow = fetchSettingRow(instancePk, "max_connections");
            Map<String, Object> sharedBuffersRow = fetchSettingRow(instancePk, "shared_buffers");
            Map<String, Object> effectiveCacheRow = fetchSettingRow(instancePk, "effective_cache_size");

            long currentWorkMemBytes = parseSettingBytes(
                workMemRow != null ? workMemRow.get("setting_value") : null,
                workMemRow != null ? workMemRow.get("unit") : null,
                4L * 1024L * 1024L);
            String workMem = formatSetting(
                workMemRow != null ? workMemRow.get("setting_value") : null,
                workMemRow != null ? workMemRow.get("unit") : null,
                humanBytes(currentWorkMemBytes));
            String maxConnections = formatSetting(
                maxConnectionsRow != null ? maxConnectionsRow.get("setting_value") : null,
                maxConnectionsRow != null ? maxConnectionsRow.get("unit") : null,
                "?");
            String sharedBuffers = formatSetting(
                sharedBuffersRow != null ? sharedBuffersRow.get("setting_value") : null,
                sharedBuffersRow != null ? sharedBuffersRow.get("unit") : null,
                "?");
            String effectiveCacheSize = formatSetting(
                effectiveCacheRow != null ? effectiveCacheRow.get("setting_value") : null,
                effectiveCacheRow != null ? effectiveCacheRow.get("unit") : null,
                "?");

            // Fallback pencere: 15 dk'da boşsa 60 dk, sonra 1440 dk dene.
            // Sebep: pgss collection ~5 dk frekansta, statement-level temp attribution
            // gecikmeli/kayıp olabilir (FETCH/cursor, ilk sample baseline). Database-level
            // temp_files alert tetiklendi ama statement detayı henüz pgss_delta'ya gelmemiş
            // olabilir — bu durumda kullanıcıya hiç sorgu göstermemek yerine genişletilmiş
            // pencereden top 5 sorguyu göstermek daha aksiyon-odaklı.
            int actualWindow = windowMinutes;
            boolean windowExtended = false;
            List<Map<String, Object>> topQueries = fetchTopTempQueries(instancePk, actualWindow);
            if (topQueries.isEmpty() && windowMinutes < 60) {
                actualWindow = 60;
                topQueries = fetchTopTempQueries(instancePk, actualWindow);
                windowExtended = !topQueries.isEmpty();
            }
            if (topQueries.isEmpty() && actualWindow < 1440) {
                actualWindow = 1440;
                topQueries = fetchTopTempQueries(instancePk, actualWindow);
                windowExtended = !topQueries.isEmpty();
            }

            long totalTempBytes = 0;
            long totalTempBlks = 0;
            long totalCalls = 0;
            long maxTempBytesPerCall = 0;
            for (Map<String, Object> q : topQueries) {
                totalTempBytes += toLong(q.get("temp_bytes"));
                totalTempBlks += toLong(q.get("temp_blks"));
                totalCalls += toLong(q.get("calls_window"));
                maxTempBytesPerCall = Math.max(maxTempBytesPerCall, toLong(q.get("avg_temp_bytes_per_call")));
            }

            WorkMemAdvice workMemAdvice = buildWorkMemAdvice(
                currentWorkMemBytes,
                maxTempBytesPerCall,
                parseSettingLong(maxConnectionsRow != null ? maxConnectionsRow.get("setting_value") : null, 0),
                parseSettingBytes(
                    sharedBuffersRow != null ? sharedBuffersRow.get("setting_value") : null,
                    sharedBuffersRow != null ? sharedBuffersRow.get("unit") : null,
                    0),
                parseSettingBytes(
                    effectiveCacheRow != null ? effectiveCacheRow.get("setting_value") : null,
                    effectiveCacheRow != null ? effectiveCacheRow.get("unit") : null,
                    0)
            );
            String suggestedWorkMem = workMemAdvice.suggestedWorkMem();
            long suggestedWorkMemBytes = parseWorkMemText(suggestedWorkMem, currentWorkMemBytes);

            StringBuilder summary = new StringBuilder();
            // Pencere genişletildi mi belirt — kullanıcı ana pencerede neden boş geldiğini bilsin
            if (windowExtended) {
                summary.append("🔎 **Temp üreten sorgular (son ").append(actualWindow).append(" dk — ana pencere ")
                    .append(windowMinutes).append(" dk'da statement-level veri yoktu, genişletildi)**\n");
            } else {
                summary.append("🔎 **Temp üreten sorgular (son ").append(actualWindow).append(" dk)**\n");
            }
            if (topQueries.isEmpty()) {
                summary.append("• Sorgu bazlı temp blok verisi bulunamadı (24 saat içinde de yok). `pg_stat_statements.temp_blks_written` toplaması yapılmamış veya FETCH/cursor gibi attribution-suz işlemler olabilir.\n");
            } else {
                for (int i = 0; i < Math.min(3, topQueries.size()); i++) {
                    Map<String, Object> q = topQueries.get(i);
                    summary.append(i + 1).append(". `")
                        .append(trimText((String) q.get("query_text"), 120)).append("`")
                        .append(" → ").append(humanBytes(toLong(q.get("temp_bytes"))))
                        .append(", calls=").append(q.get("calls_window"))
                        .append(", 28g calls=").append(q.get("calls_28d"))
                        .append(", detay=/statements/").append(q.get("statement_series_id"))
                        .append("\n");
                }
            }
            summary.append("Mevcut `work_mem`: **").append(workMem)
                .append("**, max_connections=").append(maxConnections)
                .append(", shared_buffers=").append(sharedBuffers)
                .append(", effective_cache_size=").append(effectiveCacheSize).append("\n");
            // Temp yazildi -> bu sorgu icin work_mem yetmedi. Sebepler farkli olabilir;
            // mesaj kesin tesis koymadan ihtimalleri listeler.
            summary.append("🎯 Query-level öneri: **SET LOCAL work_mem >= '").append(suggestedWorkMem).append("'**");
            summary.append(" (en yüksek ort. temp/call: ").append(humanBytes(maxTempBytesPerCall)).append("). ");
            summary.append("Olası sebepler: kötü row estimate, parallel hash spill, index eksikliği, ");
            summary.append("yetersiz parallel worker. EXPLAIN (ANALYZE, BUFFERS) ile root cause tespit edin. ");
            summary.append(workMemAdvice.guidance());

            StringBuilder json = new StringBuilder();
            json.append("{\"kind\":\"temp_files\"");
            json.append(",\"baseline_hour\":").append(hour);
            json.append(",\"baseline_avg\":").append(baselineAvg);
            json.append(",\"warning_threshold\":").append(warningThreshold);
            json.append(",\"critical_threshold\":").append(criticalThreshold);
            json.append(",\"sensitivity\":\"").append(sensitivity).append("\"");
            json.append(",\"window_minutes\":").append(windowMinutes);
            json.append(",\"actual_window_minutes\":").append(actualWindow);
            json.append(",\"window_extended\":").append(windowExtended);
            json.append(",\"work_mem\":\"").append(escapeJson(workMem)).append("\"");
            json.append(",\"work_mem_bytes\":").append(currentWorkMemBytes);
            json.append(",\"max_connections\":\"").append(escapeJson(maxConnections)).append("\"");
            json.append(",\"shared_buffers\":\"").append(escapeJson(sharedBuffers)).append("\"");
            json.append(",\"effective_cache_size\":\"").append(escapeJson(effectiveCacheSize)).append("\"");
            json.append(",\"safe_global_work_mem\":\"").append(escapeJson(workMemAdvice.safeGlobalWorkMem())).append("\"");
            json.append(",\"suggested_work_mem\":\"").append(escapeJson(suggestedWorkMem)).append("\"");
            json.append(",\"suggested_work_mem_bytes\":").append(suggestedWorkMemBytes);
            json.append(",\"max_temp_bytes_per_call\":").append(maxTempBytesPerCall);
            json.append(",\"total_temp_bytes_top_queries\":").append(totalTempBytes);
            json.append(",\"total_temp_blks_top_queries\":").append(totalTempBlks);
            json.append(",\"total_calls_top_queries\":").append(totalCalls);
            json.append(",\"top_queries\":[");
            for (int i = 0; i < topQueries.size(); i++) {
                Map<String, Object> q = topQueries.get(i);
                if (i > 0) json.append(",");
                json.append("{\"statement_series_id\":").append(q.get("statement_series_id"));
                json.append(",\"queryid\":").append(q.get("queryid"));
                json.append(",\"query_text\":\"").append(escapeJson(q.get("query_text"))).append("\"");
                json.append(",\"datname\":\"").append(escapeJson(q.get("datname"))).append("\"");
                json.append(",\"rolname\":\"").append(escapeJson(q.get("rolname"))).append("\"");
                json.append(",\"temp_blks\":").append(q.get("temp_blks"));
                json.append(",\"temp_bytes\":").append(q.get("temp_bytes"));
                json.append(",\"avg_temp_bytes_per_call\":").append(nullToZero(q.get("avg_temp_bytes_per_call")));
                json.append(",\"calls_window\":").append(q.get("calls_window"));
                json.append(",\"exec_ms_window\":").append(q.get("exec_ms_window"));
                json.append(",\"calls_7d\":").append(q.get("calls_7d"));
                json.append(",\"calls_28d\":").append(q.get("calls_28d"));
                json.append(",\"active_days_28d\":").append(q.get("active_days_28d"));
                json.append(",\"last_seen_at\":\"").append(escapeJson(q.get("last_seen_at"))).append("\"");
                json.append(",\"detail_url\":\"/statements/").append(q.get("statement_series_id")).append("\"");
                json.append("}");
            }
            json.append("]}");

            return new TempRuleDetails(json.toString(), summary.toString(), workMem,
                suggestedWorkMem, topQueriesText(topQueries));
        } catch (Exception e) {
            log.debug("Temp file detay hatasi instance={}: {}", instancePk, e.getMessage());
            return null;
        }
    }

    /**
     * Belirtilen pencerede temp_blks_written > 0 olan top 5 sorguyu döner.
     * 28 günlük frekans bilgisi (calls_7d/28d/active_days) ile birlikte zenginleştirilir.
     * Boş list dönerse pencere o aralıkta statement-level temp veri yok demektir —
     * çağıran fallback pencere ile yeniden deneyebilir.
     */
    private List<Map<String, Object>> fetchTopTempQueries(long instancePk, int windowMinutes) {
        return jdbc.queryForList("""
            with top_window as (
              select
                d.statement_series_id,
                ss.queryid,
                left(qt.query_text, 300) as query_text,
                dbr.datname,
                rr.rolname,
                sum(coalesce(d.temp_blks_written_delta, 0)) as temp_blks,
                sum(coalesce(d.temp_blks_written_delta, 0)) * 8192 as temp_bytes,
                sum(coalesce(d.calls_delta, 0)) as calls_window,
                sum(coalesce(d.total_exec_time_ms_delta, 0)) as exec_ms_window
              from fact.pgss_delta d
              join dim.statement_series ss on ss.statement_series_id = d.statement_series_id
              left join dim.query_text qt on qt.query_text_id = ss.query_text_id
              left join dim.database_ref dbr on dbr.instance_pk = ss.instance_pk and dbr.dbid = ss.dbid
              left join dim.role_ref rr on rr.instance_pk = ss.instance_pk and rr.userid = ss.userid
              where d.instance_pk = ?
                and d.sample_ts >= now() - ((? || ' minutes')::interval)
                and coalesce(d.temp_blks_written_delta, 0) > 0
              group by d.statement_series_id, ss.queryid, qt.query_text, dbr.datname, rr.rolname
              order by sum(coalesce(d.temp_blks_written_delta, 0)) desc
              limit 5
            )
            select
              t.*,
              round(t.temp_bytes::numeric / nullif(t.calls_window, 0), 0) as avg_temp_bytes_per_call,
              h.calls_7d,
              h.calls_28d,
              h.active_days_28d,
              h.last_seen_at
            from top_window t
            left join lateral (
              select
                coalesce(sum(d.calls_delta) filter (where d.sample_ts >= now() - interval '7 days'), 0) as calls_7d,
                coalesce(sum(d.calls_delta) filter (where d.sample_ts >= now() - interval '28 days'), 0) as calls_28d,
                count(distinct date_trunc('day', d.sample_ts)) filter (where d.sample_ts >= now() - interval '28 days') as active_days_28d,
                max(d.sample_ts) as last_seen_at
              from fact.pgss_delta d
              where d.statement_series_id = t.statement_series_id
                and d.sample_ts >= now() - interval '28 days'
            ) h on true
            order by t.temp_bytes desc
            """, instancePk, String.valueOf(windowMinutes));
    }

    private String topQueriesText(List<Map<String, Object>> topQueries) {
        if (topQueries.isEmpty()) return "(sorgu bazli temp veri yok)";
        StringBuilder sb = new StringBuilder("En çok diske yazan sorgular (çağrı başına temp):\n");
        for (int i = 0; i < Math.min(3, topQueries.size()); i++) {
            if (i > 0) sb.append("\n");
            Map<String, Object> q = topQueries.get(i);
            long perCall = toLong(q.get("avg_temp_bytes_per_call"));
            long calls = toLong(q.get("calls_window"));
            long total = toLong(q.get("temp_bytes"));
            sb.append(i + 1).append(". ")
                .append(humanBytes(perCall)).append("/çağrı × ")
                .append(calls).append(" çağrı = ")
                .append(humanBytes(total)).append(" toplam\n   `")
                .append(trimText((String) q.get("query_text"), 120)).append("`");
        }
        return sb.toString();
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
    // adaptive per-record: statement/table/index icin sorgu bazli anomaly
    // =========================================================================

    /**
     * Granular adaptive: her queryid/tablo/index icin 4 haftalik saatlik baseline
     * hesaplar, avg + k*stddev esigini asan record'lar icin alert olusturur.
     * Hangi sorgu/tablo anormal net belli olur.
     */
    private void evaluateAdaptivePerRecord(Map<String, Object> rule) {
        long ruleId = toLong(rule.get("rule_id"));
        String metricType = (String) rule.get("metric_type");
        String metricName = (String) rule.get("metric_name");
        int windowMinutes = toInt(rule.get("evaluation_window_minutes"));
        String sensitivity = rule.get("sensitivity") != null ? (String) rule.get("sensitivity") : "medium";
        int cooldownMinutes = toInt(rule.get("cooldown_minutes"));
        boolean autoResolve = Boolean.TRUE.equals(rule.get("auto_resolve"));
        String ruleName = (String) rule.get("rule_name");

        BigDecimal kMultiplier = switch (sensitivity) {
            case "low"  -> new BigDecimal("3.0");
            case "high" -> new BigDecimal("1.5");
            default     -> new BigDecimal("2.0");
        };

        int currentHour = java.time.OffsetDateTime.now(java.time.ZoneOffset.UTC).getHour();

        List<Map<String, Object>> targets = loadTargetInstances(rule);
        if (targets.isEmpty()) return;

        for (Map<String, Object> target : targets) {
            long instancePk = toLong(target.get("instance_pk"));
            String serviceGroup = (String) target.get("service_group");
            String alertKey = "rule:" + ruleId + ":instance:" + instancePk;

            if (isInCooldown(ruleId, instancePk, cooldownMinutes)) continue;

            // Per-record anomaly tespiti: baseline asan record'lari bul
            // user warning_threshold varsa class_floor yerine kullanilir.
            BigDecimal userThreshold = toBD(rule.get("warning_threshold"));
            List<Map<String, Object>> anomalies = findAnomalousRecords(
                instancePk, metricType, metricName, windowMinutes, currentHour, kMultiplier, userThreshold);
            enrichStatementRecords(instancePk, anomalies, metricType, windowMinutes);

            String prevSeverity = getPrevSeverity(ruleId, instancePk);

            if (anomalies.isEmpty()) {
                if (prevSeverity != null && autoResolve) alertRepo.resolve(alertKey);
                updateLastEval(ruleId, instancePk, BigDecimal.ZERO, null);
                continue;
            }

            Map<String, Object> top = anomalies.get(0);
            BigDecimal currentVal = toBDSafe(top.get("current_val"));
            BigDecimal baselineAvg = toBDSafe(top.get("baseline_avg"));
            BigDecimal upperWarning = toBDSafe(top.get("upper_warning"));
            BigDecimal upperCritical = toBDSafe(top.get("upper_critical"));

            if (currentVal == null || upperWarning == null) {
                updateLastEval(ruleId, instancePk, BigDecimal.ZERO, null);
                continue;
            }

            // Severity oncelikle SQL'den gelen auto_severity (Gate E frekans).
            // auto_severity yoksa (eski path, table/index) z-score esikleri.
            String autoSev = top.get("auto_severity") != null ? top.get("auto_severity").toString() : null;
            String severity;
            if (autoSev != null) {
                severity = autoSev;
            } else if (upperCritical != null && currentVal.compareTo(upperCritical) > 0) {
                severity = "critical";
            } else {
                severity = "warning";
            }
            long recurCount = top.get("recur_count_7d") != null
                ? ((Number) top.get("recur_count_7d")).longValue() : 0;

            Map<String, Object> ctx = baseContext(rule, instancePk, severity);
            ctx.put("value", currentVal);
            ctx.put("current_value", currentVal);
            ctx.put("baseline_avg", baselineAvg);
            ctx.put("upper_warning", upperWarning);
            ctx.put("upper_critical", upperCritical);
            ctx.put("threshold", "critical".equals(severity) ? upperCritical : upperWarning);
            ctx.put("baseline_hour", currentHour);
            ctx.put("sensitivity", sensitivity);
            ctx.put("window", windowMinutes);
            ctx.put("recur_count_7d", recurCount);
            populateRecordCtx(ctx, top, metricType);
            ctx.put("top_queries_summary", buildTopSummaryText(anomalies, metricType));

            String fallbackMsg = buildPerRecordAdaptiveMessage(metricType, metricName, top,
                currentVal, baselineAvg, severity, currentHour);
            String detailsJson = buildPerRecordsJson(anomalies, metricType, windowMinutes,
                "sensitivity=" + sensitivity + " k=" + kMultiplier, "adaptive_anomaly");

            String code = templateCodeForType(metricType, "spike");
            String[] rendered = renderWithCode(rule, ctx, ruleName, fallbackMsg, code);

            alertRepo.upsert(alertKey, AlertCode.USER_DEFINED_RULE,
                instancePk, serviceGroup, null, rendered[0], rendered[1], detailsJson);
            jdbc.update("update ops.alert set severity = ? where alert_key = ?", severity, alertKey);

            updateLastEval(ruleId, instancePk, currentVal, severity);
        }
    }

    /**
     * Per-record anomaly tespiti: her queryid/tablo/index icin
     * son N dk degeri vs 4 haftalik ayni saat baseline (avg + k*stddev).
     * Esigi asanlari doner.
     */
    /**
     * MAD-tabanli adaptive anomaly tespiti — 4 kapilik filtre:
     *   Gate A: baseline_median >= class_floor (gurultu degil)
     *   Gate B: current_val >= effective_floor (max class_floor, rule.warning_threshold)
     *   Gate C: (current - baseline) / baseline >= 0.50 (%50 artis)
     *   Gate D: robust_z = 0.6745 * (current - median) / mad > sensitivity_k
     *
     * MAD outlier'a dayanikli; tek bir spike baseline'i bozmaz.
     * class_floor: metric_name'e gore otomatik (gurultu seviyesi).
     * warning_threshold: kullanici override; varsa floor yerine kullanilir.
     */
    private List<Map<String, Object>> findAnomalousRecords(long instancePk,
                                                            String metricType, String metricName,
                                                            int windowMinutes, int currentHour,
                                                            BigDecimal kMultiplier) {
        return findAnomalousRecords(instancePk, metricType, metricName, windowMinutes,
            currentHour, kMultiplier, null);
    }

    private List<Map<String, Object>> findAnomalousRecords(long instancePk,
                                                            String metricType, String metricName,
                                                            int windowMinutes, int currentHour,
                                                            BigDecimal kMultiplier,
                                                            BigDecimal userThreshold) {
        try {
            String col = toFactColumn(metricName, metricType);
            BigDecimal classFloor = getMetricClassFloor(metricName);
            // Effective floor: kullanici warning_threshold yazdiysa onu kullan, yoksa class default.
            BigDecimal effectiveFloor = (userThreshold != null && userThreshold.signum() > 0)
                ? userThreshold : classFloor;
            BigDecimal pctChangeGate = new BigDecimal("0.50");  // %50 artis kapisi
            BigDecimal madScale = new BigDecimal("0.6745");      // MAD -> stddev esdegerleme
            return switch (metricType) {
                case "statement_metric" -> jdbc.queryForList(buildStatementAdaptiveSql(col),
                    instancePk, windowMinutes + " minutes",
                    instancePk, windowMinutes + " minutes", currentHour,
                    kMultiplier, kMultiplier,                            // upper_warning/critical: median + k*MAD (1.5σ approx)
                    classFloor, effectiveFloor, pctChangeGate, kMultiplier);   // Gates A/B/C/D

                case "table_metric" -> {
                    String tCol = toFactColumn(metricName, "table_metric");
                    yield jdbc.queryForList(buildTableAdaptiveSql(tCol),
                        instancePk, windowMinutes + " minutes",
                        instancePk, windowMinutes + " minutes", currentHour,
                        kMultiplier, kMultiplier,
                        classFloor, effectiveFloor, pctChangeGate, kMultiplier);
                }

                case "index_metric" -> {
                    String iCol = toFactColumn(metricName, "index_metric");
                    yield jdbc.queryForList(buildIndexAdaptiveSql(iCol),
                        instancePk, windowMinutes + " minutes",
                        instancePk, windowMinutes + " minutes", currentHour,
                        kMultiplier, kMultiplier,
                        classFloor, effectiveFloor, pctChangeGate, kMultiplier);
                }

                default -> java.util.Collections.emptyList();
            };
        } catch (Exception e) {
            log.warn("findAnomalousRecords hatasi {}/{} instance={}: {}",
                metricType, metricName, instancePk, e.getMessage());
            return java.util.Collections.emptyList();
        }
    }

    /** Per-record adaptive anomaly mesaji */
    private String buildPerRecordAdaptiveMessage(String metricType, String metricName,
                                                  Map<String, Object> rec, BigDecimal current,
                                                  BigDecimal baseline, String severity, int hour) {
        long recurCount = rec.get("recur_count_7d") != null
            ? ((Number) rec.get("recur_count_7d")).longValue() : 0;
        String recurSuffix = recurCount >= 2
            ? String.format(" [son 7 günde %d kez eşik aşıldı — %s]", recurCount,
                recurCount >= 5 ? "sürekli sorun" : "pattern başlıyor")
            : "";
        return switch (metricType) {
            case "statement_metric" -> String.format(
                "Sorgu anomali: %s = %s (saat %02d:00 baseline median=%s, %s). DB=%s User=%s Q=%s%s",
                metricName, current, hour, baseline, severity,
                rec.get("datname"), rec.get("rolname"),
                trimText((String) rec.get("query_text"), 80),
                recurSuffix);
            case "table_metric" -> String.format(
                "Tablo anomali: %s = %s (saat %02d:00 baseline median=%s). Tablo=%s.%s",
                metricName, current, hour, baseline, rec.get("schemaname"), rec.get("relname"));
            case "index_metric" -> String.format(
                "Index anomali: %s = %s (saat %02d:00 baseline median=%s). Index=%s.%s",
                metricName, current, hour, baseline, rec.get("schemaname"), rec.get("indexrelname"));
            default -> "Anomali tespit edildi";
        };
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
                String detailsJson = null;
                TempRuleDetails tempDetails = null;
                if (isDatabaseTempFilesRule(metricType, metricName)) {
                    tempDetails = buildTempFileRuleDetails(instancePk, windowMinutes,
                        BigDecimal.ZERO, warningThreshold, criticalThreshold, -1, "threshold");
                    if (tempDetails != null) {
                        detailsJson = tempDetails.detailsJson();
                        ctx.put("work_mem", tempDetails.workMem());
                        ctx.put("suggested_work_mem", tempDetails.suggestedWorkMem());
                        ctx.put("top_temp_queries", tempDetails.topQueriesText());
                    }
                }
                String[] rendered = buildAlertText(rule, ruleName, message, ctx);
                if (tempDetails != null && !tempDetails.messageSuffix().isBlank()) {
                    rendered[1] = rendered[1] + "\n\n" + tempDetails.messageSuffix();
                }
                alertRepo.upsertWithSeverity(alertKey, AlertCode.USER_DEFINED_RULE,
                    severity, instancePk, serviceGroup, rendered[0], rendered[1], ruleId, detailsJson);
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
                ctx.put("current_value", current);
                ctx.put("previous_value", prev);
                ctx.put("change_pct", changePct);
                ctx.put("threshold", changeThresholdPct);
                ctx.put("window", windowMinutes);

                // Statement/table/index metrikleri icin top contributor query bilgisi ekle
                String detailsJson = null;
                if (isGranularMetricType(metricType)) {
                    List<Map<String, Object>> contributors = findRecordsTopContributors(
                        instancePk, metricType, metricName, windowMinutes, true);
                    if (!contributors.isEmpty()) {
                        populateRecordCtx(ctx, contributors.get(0), metricType);
                        ctx.put("top_queries_summary", buildTopSummaryText(contributors, metricType));
                        detailsJson = buildPerRecordsJson(contributors, metricType, windowMinutes,
                            changePct.toPlainString() + "% artis", "spike");
                    }
                }

                String code = isGranularMetricType(metricType)
                    ? templateCodeForType(metricType, "spike") : null;
                String[] rendered;
                if (code != null) {
                    rendered = renderWithCode(rule, ctx, ruleName, message, code);
                } else {
                    rendered = buildAlertText(rule, ruleName, message, ctx);
                }

                if (detailsJson != null) {
                    alertRepo.upsert(alertKey, AlertCode.USER_DEFINED_RULE,
                        instancePk, serviceGroup, null, rendered[0], rendered[1], detailsJson);
                    jdbc.update("update ops.alert set severity = ?, rule_id = ? where alert_key = ?",
                        severity, ruleId, alertKey);
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
                // Per-record spike bulunamadi ama instance toplami spike yapmis olabilir.
                // Instance-level fallback: toplam current vs prev karsilastir, top query'leri ekle.
                BigDecimal instCurrent = queryInstanceTotal(instancePk, metricType, metricName, "sum", windowMinutes + " minutes");
                BigDecimal instPrev    = queryInstanceTotalPrev(instancePk, metricType, metricName, "sum", windowMinutes);
                if (instCurrent != null && instPrev != null && instPrev.compareTo(BigDecimal.ZERO) > 0) {
                    BigDecimal instChange = computeChangePct(instCurrent, instPrev);
                    if (instChange.compareTo(thresholdPct) > 0) {
                        // Instance-level spike var ama tek query degil, dagilmis artis
                        String severity = instChange.compareTo(thresholdPct.multiply(new BigDecimal("3"))) > 0
                            ? "critical" : "warning";

                        // Top contributor query'leri bul
                        List<Map<String, Object>> contributors = findRecordsTopContributors(
                            instancePk, metricType, metricName, windowMinutes, true);

                        Map<String, Object> ctx = baseContext(rule, instancePk, severity);
                        ctx.put("value", instCurrent);
                        ctx.put("current_value", instCurrent);
                        ctx.put("previous_value", instPrev);
                        ctx.put("change_pct", instChange);
                        ctx.put("threshold", thresholdPct);
                        ctx.put("window", windowMinutes);

                        // Top contributor varsa context'e ekle
                        if (!contributors.isEmpty()) {
                            Map<String, Object> topC = contributors.get(0);
                            populateRecordCtx(ctx, topC, metricType);
                            ctx.put("top_queries_summary", buildTopSummaryText(contributors, metricType));
                            ctx.put("note", "Tek sorgu spike etmedi, toplam artis birden fazla sorgudan geldi");
                        }

                        String fallbackMsg = String.format(
                            "%s: instance toplam son %d dk = %s, onceki %d dk = %s — %%.0f artis (esik: %%.0f%%). " +
                            "Tek sorgu spike etmedi, artis birden fazla sorgudan geldi.",
                            metricName, windowMinutes, instCurrent, windowMinutes, instPrev)
                            .formatted(instChange.doubleValue(), thresholdPct.doubleValue());

                        String detailsJson = buildPerRecordsJson(contributors, metricType, windowMinutes,
                            thresholdPct.toPlainString() + "%", "spike_distributed");

                        String code = templateCodeForType(metricType, "spike");
                        String[] rendered = renderWithCode(rule, ctx, ruleName, fallbackMsg, code);

                        alertRepo.upsert(alertKey, AlertCode.USER_DEFINED_RULE,
                            instancePk, serviceGroup, null, rendered[0], rendered[1], detailsJson);
                        jdbc.update("update ops.alert set severity = ? where alert_key = ?", severity, alertKey);
                        updateLastEval(ruleId, instancePk, instChange, severity);
                        continue;
                    }
                }

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
            ctx.put("top_queries_summary", buildTopSummaryText(spiking, metricType));

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
                    // Mevcut pencere + önceki pencere karşılaştırması ile top contributor
                    List<Map<String, Object>> rows = jdbc.queryForList(
                        "with curr as (" +
                        "  select ss.queryid, ss.dbid, ss.userid, ss.statement_series_id," +
                        "         sum(d." + col + ")::numeric as current_val" +
                        "  from fact.pgss_delta d" +
                        "  join dim.statement_series ss on ss.statement_series_id = d.statement_series_id" +
                        "  where d.instance_pk = ? and d.sample_ts > now() - ?::interval" +
                        "  group by ss.queryid, ss.dbid, ss.userid, ss.statement_series_id" +
                        "), prev as (" +
                        "  select ss.statement_series_id, sum(d." + col + ")::numeric as prev_val" +
                        "  from fact.pgss_delta d" +
                        "  join dim.statement_series ss on ss.statement_series_id = d.statement_series_id" +
                        "  where d.instance_pk = ? and d.sample_ts > now() - ?::interval" +
                        "    and d.sample_ts <= now() - ?::interval" +
                        "  group by ss.statement_series_id" +
                        ")" +
                        " select c.statement_series_id, c.queryid, c.dbid, c.userid, c.current_val, coalesce(p.prev_val, 0) as prev_val," +
                        "   case when coalesce(p.prev_val,0) = 0 and c.current_val > 0 then 9999.0" +
                        "        when coalesce(p.prev_val,0) = 0 then 0.0" +
                        "        else round(((c.current_val - p.prev_val) * 100.0 / nullif(p.prev_val, 0))::numeric, 1)" +
                        "   end as change_pct," +
                        "   left(coalesce(qt.query_text, '?'), 200) as query_text," +
                        "   dbr.datname, rr.rolname" +
                        " from curr c" +
                        " left join prev p on p.statement_series_id = c.statement_series_id" +
                        " left join dim.statement_series ss on ss.statement_series_id = c.statement_series_id" +
                        " left join dim.query_text qt on qt.query_text_id = ss.query_text_id" +
                        " left join dim.database_ref dbr on dbr.instance_pk = ? and dbr.dbid = c.dbid" +
                        " left join dim.role_ref rr on rr.instance_pk = ? and rr.userid = c.userid" +
                        " where c.current_val > 0" +
                        " order by c.current_val " + order + " nulls last limit 10",
                        instancePk, windowMinutes + " minutes",
                        instancePk, (windowMinutes * 2) + " minutes", windowMinutes + " minutes",
                        instancePk, instancePk);
                    enrichStatementRecords(instancePk, rows, metricType, windowMinutes);
                    yield rows;
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
                "select c.statement_series_id, c.queryid, c.dbid, c.userid," +
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

            List<Map<String, Object>> rows = jdbc.queryForList(sql,
                instancePk, windowMinutes + " minutes",         // current_window
                instancePk, (windowMinutes * 2) + " minutes",   // prev_window from
                            windowMinutes + " minutes",         // prev_window to
                instancePk, instancePk,                         // refs
                thresholdPct);
            enrichStatementRecords(instancePk, rows, "statement_metric", windowMinutes);
            return rows;
        } catch (Exception e) {
            log.warn("findTopSpikingStatements hatasi instance={}: {}", instancePk, e.getMessage());
            return java.util.Collections.emptyList();
        }
    }

    // =========================================================================
    // Instance-level toplam sorgu (granular spike fallback icin)
    // =========================================================================

    /** Tek instance icin mevcut penceredeki toplam metrik degeri */
    private BigDecimal queryInstanceTotal(long instancePk, String metricType,
                                           String metricName, String aggFn, String interval) {
        List<Map<String, Object>> rows = queryMetric(metricType, metricName, aggFn, interval);
        return findValueForInstance(rows, instancePk);
    }

    /** Tek instance icin onceki penceredeki toplam metrik degeri (spike: 2*window..window) */
    private BigDecimal queryInstanceTotalPrev(long instancePk, String metricType,
                                               String metricName, String aggFn, int windowMinutes) {
        List<Map<String, Object>> rows = queryMetricAtOffset(metricType, metricName, aggFn, windowMinutes, 0);
        return findValueForInstance(rows, instancePk);
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
            enrichStatementRecords(instancePk, exceeding, metricType, windowMinutes);

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
                ctx.put("statement_series_id", rec.get("statement_series_id"));
                ctx.put("statement_detail_url", rec.get("detail_url"));
                ctx.put("calls_window", rec.get("calls_window"));
                ctx.put("calls_7d", rec.get("calls_7d"));
                ctx.put("calls_28d", rec.get("calls_28d"));
                ctx.put("active_days_28d", rec.get("active_days_28d"));
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

    private void enrichStatementRecords(long instancePk, List<Map<String, Object>> records,
                                        String metricType, int windowMinutes) {
        if (!"statement_metric".equals(metricType) || records == null || records.isEmpty()) {
            return;
        }

        for (Map<String, Object> record : records) {
            Object seriesIdObj = record.get("statement_series_id");
            if (!(seriesIdObj instanceof Number)) {
                continue;
            }

            long statementSeriesId = ((Number) seriesIdObj).longValue();
            record.put("detail_url", "/statements/" + statementSeriesId);

            try {
                Map<String, Object> stats = jdbc.queryForMap(
                    "select " +
                    "  coalesce(sum(d.calls_delta) filter (where d.sample_ts > now() - ?::interval), 0)::bigint as calls_window," +
                    "  coalesce(sum(d.total_exec_time_ms_delta) filter (where d.sample_ts > now() - ?::interval), 0)::numeric as exec_ms_window," +
                    "  coalesce(sum(d.calls_delta) filter (where d.sample_ts > now() - interval '7 days'), 0)::bigint as calls_7d," +
                    "  coalesce(sum(d.calls_delta) filter (where d.sample_ts > now() - interval '28 days'), 0)::bigint as calls_28d," +
                    "  count(distinct date_trunc('day', d.sample_ts)) filter (where d.sample_ts > now() - interval '28 days') as active_days_28d," +
                    "  max(d.sample_ts) as last_seen_at" +
                    " from fact.pgss_delta d" +
                    " where d.instance_pk = ? and d.statement_series_id = ?" +
                    "   and d.sample_ts > now() - interval '28 days'",
                    windowMinutes + " minutes", windowMinutes + " minutes", instancePk, statementSeriesId);
                record.putAll(stats);
            } catch (Exception e) {
                log.debug("statement alert enrichment skipped statement_series_id={}: {}", statementSeriesId, e.getMessage());
            }
        }
    }

    private static String humanBytes(long bytes) {
        if (bytes >= 1_073_741_824L) return String.format("%.1f GB", bytes / 1_073_741_824.0);
        if (bytes >= 1_048_576L) return String.format("%.1f MB", bytes / 1_048_576.0);
        if (bytes >= 1_024L) return String.format("%.1f KB", bytes / 1_024.0);
        return bytes + " B";
    }

    private static Object nullToZero(Object value) {
        return value != null ? value : 0;
    }

    private static String formatSetting(Object value, Object unit, String fallback) {
        if (value == null) return fallback;
        String val = value.toString().trim();
        String u = unit != null ? unit.toString().trim() : "";
        // value zaten birim icerirse (ornek: "10485kB") unit'i ekleme
        if (!u.isBlank() && val.matches("^[0-9]+(?:\\.[0-9]+)?\\s*[a-zA-Z]+$")) {
            return val;
        }
        return u.isBlank() ? val : val + u;
    }

    private static long parseSettingBytes(Object value, Object unit, long fallbackBytes) {
        if (value == null) return fallbackBytes;
        try {
            // value bazi durumlarda "10485kB" gibi composite gelebilir; sayi/unit ayrimi
            // yapilmamissa elle ayikla.
            String raw = value.toString().trim();
            String numericPart = raw;
            String inlineUnit = null;
            java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("^([0-9]+(?:\\.[0-9]+)?)\\s*([a-zA-Z]+)?$").matcher(raw);
            if (m.matches()) {
                numericPart = m.group(1);
                if (m.group(2) != null && !m.group(2).isBlank()) inlineUnit = m.group(2);
            }
            BigDecimal n = new BigDecimal(numericPart);
            String u = inlineUnit != null
                ? inlineUnit.trim().toLowerCase()
                : (unit != null ? unit.toString().trim().toLowerCase() : "kb");
            BigDecimal multiplier = switch (u) {
                case "b", "byte", "bytes" -> BigDecimal.ONE;
                case "kb" -> new BigDecimal(1024);
                case "8kb" -> new BigDecimal(8192);
                case "mb" -> new BigDecimal(1_048_576);
                case "gb" -> new BigDecimal(1_073_741_824);
                default -> new BigDecimal(1024);
            };
            return n.multiply(multiplier).longValue();
        } catch (Exception e) {
            return fallbackBytes;
        }
    }

    private Map<String, Object> fetchSettingRow(long instancePk, String settingName) {
        try {
            List<Map<String, Object>> rows = jdbc.queryForList("""
                select setting_value, unit
                from fact.pg_settings_snapshot
                where instance_pk = ? and setting_name = ?
                order by snapshot_ts desc
                limit 1
                """, instancePk, settingName);
            return rows.isEmpty() ? null : rows.get(0);
        } catch (Exception e) {
            return null;
        }
    }

    private record WorkMemAdvice(String suggestedWorkMem, String safeGlobalWorkMem, String guidance) {}

    private static WorkMemAdvice buildWorkMemAdvice(long currentWorkMemBytes, long maxTempBytesPerCall,
                                                    long maxConnections, long sharedBuffersBytes,
                                                    long effectiveCacheBytes) {
        String tempBasedText = suggestWorkMem(currentWorkMemBytes, maxTempBytesPerCall);
        long queryNeedBytes = parseWorkMemText(tempBasedText, currentWorkMemBytes);
        long safeGlobalBytes = estimateSafeGlobalWorkMemBytes(
            maxConnections, sharedBuffersBytes, effectiveCacheBytes);

        long suggestedBytes = queryNeedBytes;
        if (safeGlobalBytes > 0 && suggestedBytes > safeGlobalBytes) {
            suggestedBytes = safeGlobalBytes;
        }
        if (currentWorkMemBytes > 0 && suggestedBytes < currentWorkMemBytes) {
            suggestedBytes = currentWorkMemBytes;
        }

        String suggested = humanWorkMem(roundWorkMemBytes(suggestedBytes));
        String safeGlobal = safeGlobalBytes > 0 ? humanWorkMem(roundWorkMemBytes(safeGlobalBytes)) : "?";
        String guidance = safeGlobalBytes > 0
            ? "Konservatif global ust sinir ~= " + safeGlobal +
              " (effective_cache_size proxy; (effective_cache_size - shared_buffers) / max_connections / 2). " +
              "effective_cache_size gercek RAM degil, planner cache tahminidir."
            : "Global ust sinir hesaplanamadi; max_connections/shared_buffers/effective_cache_size snapshot eksik.";
        return new WorkMemAdvice(suggested, safeGlobal, guidance);
    }

    private static long estimateSafeGlobalWorkMemBytes(long maxConnections, long sharedBuffersBytes,
                                                       long effectiveCacheBytes) {
        if (maxConnections <= 0 || effectiveCacheBytes <= 0) return 0;
        long memoryProxy = effectiveCacheBytes > sharedBuffersBytes
            ? effectiveCacheBytes - sharedBuffersBytes
            : effectiveCacheBytes / 2L;
        if (memoryProxy <= 0) return 0;
        long safe = (memoryProxy / maxConnections) / 2L;
        if (safe < 1L * 1024L * 1024L) return 0;
        return Math.min(safe, 512L * 1024L * 1024L);
    }

    private static long parseSettingLong(Object value, long fallback) {
        if (value == null) return fallback;
        try {
            return Long.parseLong(value.toString().trim());
        } catch (Exception e) {
            return fallback;
        }
    }

    private static String suggestWorkMem(long currentWorkMemBytes, long maxTempBytesPerCall) {
        if (maxTempBytesPerCall <= 0) {
            return humanWorkMem(currentWorkMemBytes);
        }
        long target = Math.max(currentWorkMemBytes, Math.round(maxTempBytesPerCall * 1.25));
        long mb = Math.max(16, (target + 1_048_575L) / 1_048_576L);
        long roundedMb;
        if (mb <= 16) roundedMb = 16;
        else if (mb <= 32) roundedMb = 32;
        else if (mb <= 64) roundedMb = 64;
        else if (mb <= 128) roundedMb = 128;
        else if (mb <= 256) roundedMb = 256;
        else roundedMb = 512;
        return roundedMb + "MB";
    }

    private static long roundWorkMemBytes(long bytes) {
        long mb = Math.max(1, bytes / 1_048_576L);
        long[] steps = {1, 2, 4, 8, 16, 32, 64, 128, 256, 512};
        long selected = steps[0];
        for (long step : steps) {
            if (mb >= step) selected = step;
        }
        return selected * 1_048_576L;
    }

    // =========================================================================
    // Adaptive — metric-class noise floor + SQL builder'lar (MAD + 4 kapi)
    // =========================================================================

    /**
     * Metric adi -> gurultu seviyesinin altinda kalan "noise floor" degeri.
     * Bu deger altinda baseline veya current oldugunda alert hic tetiklenmez.
     * Kullanici kuralda warning_threshold yazarsa onun yerine bu kullanilir.
     *
     * Datadog/pganalyze/Grafana pattern'i: istatistik sapma + pratik anlam kapisi.
     */
    private BigDecimal getMetricClassFloor(String metricName) {
        return switch (metricName == null ? "" : metricName) {
            case "avg_exec_time_ms"   -> new BigDecimal("10");          // 10ms alti hizli
            case "total_exec_time_ms" -> new BigDecimal("1000");        // 1s toplam
            case "calls"              -> new BigDecimal("50");           // 50 cagri
            case "rows"               -> new BigDecimal("100");
            case "temp_files"         -> new BigDecimal("5");
            case "temp_bytes"         -> new BigDecimal("1048576");     // 1MB
            case "blks_read"          -> new BigDecimal("1000");
            case "shared_blks_read"   -> new BigDecimal("1000");
            case "blks_hit"           -> new BigDecimal("10000");
            case "numbackends"        -> new BigDecimal("5");
            case "xact_commit", "xact_rollback" -> new BigDecimal("50");
            case "deadlocks", "conflicts"        -> new BigDecimal("1");
            case "tup_returned", "tup_fetched"   -> new BigDecimal("1000");
            case "tup_inserted", "tup_updated", "tup_deleted" -> new BigDecimal("100");
            case "seq_scan"           -> new BigDecimal("10");
            case "idx_scan"           -> new BigDecimal("100");
            case "n_dead_tup_estimate" -> new BigDecimal("1000");
            default                   -> new BigDecimal("1");
        };
    }

    /**
     * Statement-level adaptive SQL — 4 kapi:
     *   Gate A: baseline_median >= class_floor (param)
     *   Gate B: current_val >= effective_floor (param)
     *   Gate C: (current - baseline) / baseline >= pct_change (param)
     *   Gate D: robust_z = (current - median) / MAD > k_multiplier (param)
     *
     * Tum gate'ler AND ile baglanir. MAD outlier'a dayanikli.
     */
    private String buildStatementAdaptiveSql(String col) {
        return "with current_window as (" +
            "  select ss.statement_series_id, ss.queryid, ss.dbid, ss.userid," +
            "         sum(d." + col + ")::numeric as current_val," +
            "         left(coalesce(qt.query_text, '?'), 300) as query_text," +
            "         dbr.datname, rr.rolname" +
            "  from fact.pgss_delta d" +
            "  join dim.statement_series ss on ss.statement_series_id = d.statement_series_id" +
            "  left join dim.query_text qt on qt.query_text_id = ss.query_text_id" +
            "  left join dim.database_ref dbr on dbr.instance_pk = ss.instance_pk and dbr.dbid = ss.dbid" +
            "  left join dim.role_ref rr on rr.instance_pk = ss.instance_pk and rr.userid = ss.userid" +
            "  where d.instance_pk = ? and d.sample_ts > now() - ?::interval" +
            "  group by ss.statement_series_id, ss.queryid, ss.dbid, ss.userid, qt.query_text, dbr.datname, rr.rolname" +
            "), hist_raw as (" +
            "  select ss.queryid, ss.dbid, ss.userid," +
            "         date_trunc('hour', d.sample_ts) as hour_bucket," +
            "         sum(d." + col + ")::numeric as window_sum" +
            "  from fact.pgss_delta d" +
            "  join dim.statement_series ss on ss.statement_series_id = d.statement_series_id" +
            "  where d.instance_pk = ?" +
            "    and d.sample_ts > now() - interval '28 days'" +
            "    and d.sample_ts <= now() - ?::interval" +
            "    and extract(hour from d.sample_ts) = ?" +
            "  group by ss.queryid, ss.dbid, ss.userid, date_trunc('hour', d.sample_ts)" +
            "), hist_med as (" +
            "  select queryid, dbid, userid," +
            "         percentile_cont(0.5) within group (order by window_sum) as baseline_median" +
            "  from hist_raw group by queryid, dbid, userid having count(*) >= 3" +
            "), hist_mad as (" +
            "  select hm.queryid, hm.dbid, hm.userid, hm.baseline_median," +
            "         greatest(percentile_cont(0.5) within group (order by abs(hr.window_sum - hm.baseline_median)), 0.0001) as baseline_mad" +
            "  from hist_med hm" +
            "  join hist_raw hr using (queryid, dbid, userid)" +
            "  group by hm.queryid, hm.dbid, hm.userid, hm.baseline_median" +
            "), recurrence as (" +
            // Son 7 gunde bu sorgu kac kez MAD esigini gecmis? (Gate E icin sayac)
            "  select hr.queryid, hr.dbid, hr.userid, count(*) as recur_count_7d" +
            "  from hist_raw hr" +
            "  join hist_mad h using (queryid, dbid, userid)" +
            "  where hr.hour_bucket > now() - interval '7 days'" +
            "    and hr.window_sum > (h.baseline_median + 2.0 * h.baseline_mad)" +
            "  group by hr.queryid, hr.dbid, hr.userid" +
            ")" +
            "select c.statement_series_id, c.queryid, c.dbid, c.userid, c.current_val, c.query_text, c.datname, c.rolname," +
            "       h.baseline_median as baseline_avg, h.baseline_mad as baseline_stddev," +
            "       (h.baseline_median + ?::numeric * h.baseline_mad) as upper_warning," +
            "       (h.baseline_median + 1.5 * ?::numeric * h.baseline_mad) as upper_critical," +
            "       coalesce(r.recur_count_7d, 0) as recur_count_7d," +
            // Frekans-bazli auto severity (Gate E):
            //   0-1 kez -> null (alert ATILMAZ, gurultu olabilir)
            //   2-4 kez -> warning (pattern olusuyor)
            //   5+ kez  -> critical (surekli sorun)
            "       case when coalesce(r.recur_count_7d, 0) >= 5 then 'critical'" +
            "            when coalesce(r.recur_count_7d, 0) >= 2 then 'warning'" +
            "            else null end as auto_severity" +
            "  from current_window c" +
            "  join hist_mad h using (queryid, dbid, userid)" +
            "  left join recurrence r using (queryid, dbid, userid)" +
            "  where h.baseline_median >= ?::numeric" +                        // Gate A
            "    and c.current_val >= ?::numeric" +                             // Gate B
            "    and (c.current_val - h.baseline_median) >= ?::numeric * h.baseline_median" +  // Gate C
            "    and (c.current_val - h.baseline_median) / h.baseline_mad > ?::numeric" +      // Gate D MAD-z
            "    and coalesce(r.recur_count_7d, 0) >= 2" +                                      // Gate E frekans
            "  order by coalesce(r.recur_count_7d, 0) desc, (c.current_val - h.baseline_median) / h.baseline_mad desc nulls last" +
            "  limit 10";
    }

    private String buildTableAdaptiveSql(String tCol) {
        return "with current_window as (" +
            "  select t.schemaname, t.relname, t.dbid," +
            "         sum(t." + tCol + ")::numeric as current_val," +
            "         max(t.n_dead_tup_estimate) as dead_tup," +
            "         max(t.n_live_tup_estimate) as live_tup, dbr.datname" +
            "  from fact.pg_table_stat_delta t" +
            "  left join dim.database_ref dbr on dbr.instance_pk = t.instance_pk and dbr.dbid = t.dbid" +
            "  where t.instance_pk = ? and t.sample_ts > now() - ?::interval" +
            "  group by t.schemaname, t.relname, t.dbid, dbr.datname" +
            "), hist_raw as (" +
            "  select t.schemaname, t.relname, t.dbid," +
            "         date_trunc('hour', t.sample_ts) as hour_bucket," +
            "         sum(t." + tCol + ")::numeric as window_sum" +
            "  from fact.pg_table_stat_delta t" +
            "  where t.instance_pk = ?" +
            "    and t.sample_ts > now() - interval '28 days'" +
            "    and t.sample_ts <= now() - ?::interval" +
            "    and extract(hour from t.sample_ts) = ?" +
            "  group by t.schemaname, t.relname, t.dbid, date_trunc('hour', t.sample_ts)" +
            "), hist_med as (" +
            "  select schemaname, relname, dbid," +
            "         percentile_cont(0.5) within group (order by window_sum) as baseline_median" +
            "  from hist_raw group by schemaname, relname, dbid having count(*) >= 3" +
            "), hist_mad as (" +
            "  select hm.schemaname, hm.relname, hm.dbid, hm.baseline_median," +
            "         greatest(percentile_cont(0.5) within group (order by abs(hr.window_sum - hm.baseline_median)), 0.0001) as baseline_mad" +
            "  from hist_med hm" +
            "  join hist_raw hr using (schemaname, relname, dbid)" +
            "  group by hm.schemaname, hm.relname, hm.dbid, hm.baseline_median" +
            ")" +
            "select c.schemaname, c.relname, c.dbid, c.current_val, c.datname, c.dead_tup, c.live_tup," +
            "       h.baseline_median as baseline_avg, h.baseline_mad as baseline_stddev," +
            "       (h.baseline_median + ?::numeric * h.baseline_mad) as upper_warning," +
            "       (h.baseline_median + 1.5 * ?::numeric * h.baseline_mad) as upper_critical" +
            "  from current_window c" +
            "  join hist_mad h using (schemaname, relname, dbid)" +
            "  where h.baseline_median >= ?::numeric" +
            "    and c.current_val >= ?::numeric" +
            "    and (c.current_val - h.baseline_median) >= ?::numeric * h.baseline_median" +
            "    and (c.current_val - h.baseline_median) / h.baseline_mad > ?::numeric" +
            "  order by (c.current_val - h.baseline_median) / h.baseline_mad desc nulls last" +
            "  limit 10";
    }

    private String buildIndexAdaptiveSql(String iCol) {
        return "with current_window as (" +
            "  select i.schemaname, i.indexrelname, i.table_relname, i.dbid," +
            "         sum(i." + iCol + ")::numeric as current_val, dbr.datname" +
            "  from fact.pg_index_stat_delta i" +
            "  left join dim.database_ref dbr on dbr.instance_pk = i.instance_pk and dbr.dbid = i.dbid" +
            "  where i.instance_pk = ? and i.sample_ts > now() - ?::interval" +
            "  group by i.schemaname, i.indexrelname, i.table_relname, i.dbid, dbr.datname" +
            "), hist_raw as (" +
            "  select i.schemaname, i.indexrelname, i.dbid," +
            "         date_trunc('hour', i.sample_ts) as hour_bucket," +
            "         sum(i." + iCol + ")::numeric as window_sum" +
            "  from fact.pg_index_stat_delta i" +
            "  where i.instance_pk = ?" +
            "    and i.sample_ts > now() - interval '28 days'" +
            "    and i.sample_ts <= now() - ?::interval" +
            "    and extract(hour from i.sample_ts) = ?" +
            "  group by i.schemaname, i.indexrelname, i.dbid, date_trunc('hour', i.sample_ts)" +
            "), hist_med as (" +
            "  select schemaname, indexrelname, dbid," +
            "         percentile_cont(0.5) within group (order by window_sum) as baseline_median" +
            "  from hist_raw group by schemaname, indexrelname, dbid having count(*) >= 3" +
            "), hist_mad as (" +
            "  select hm.schemaname, hm.indexrelname, hm.dbid, hm.baseline_median," +
            "         greatest(percentile_cont(0.5) within group (order by abs(hr.window_sum - hm.baseline_median)), 0.0001) as baseline_mad" +
            "  from hist_med hm" +
            "  join hist_raw hr using (schemaname, indexrelname, dbid)" +
            "  group by hm.schemaname, hm.indexrelname, hm.dbid, hm.baseline_median" +
            ")" +
            "select c.schemaname, c.indexrelname, c.table_relname, c.dbid, c.current_val, c.datname," +
            "       h.baseline_median as baseline_avg, h.baseline_mad as baseline_stddev," +
            "       (h.baseline_median + ?::numeric * h.baseline_mad) as upper_warning," +
            "       (h.baseline_median + 1.5 * ?::numeric * h.baseline_mad) as upper_critical" +
            "  from current_window c" +
            "  join hist_mad h using (schemaname, indexrelname, dbid)" +
            "  where h.baseline_median >= ?::numeric" +
            "    and c.current_val >= ?::numeric" +
            "    and (c.current_val - h.baseline_median) >= ?::numeric * h.baseline_median" +
            "    and (c.current_val - h.baseline_median) / h.baseline_mad > ?::numeric" +
            "  order by (c.current_val - h.baseline_median) / h.baseline_mad desc nulls last" +
            "  limit 10";
    }

    private static long parseWorkMemText(String text, long fallbackBytes) {
        if (text == null || text.isBlank()) return fallbackBytes;
        try {
            String normalized = text.trim().toUpperCase();
            long value = Long.parseLong(normalized.replaceAll("[^0-9]", ""));
            if (normalized.endsWith("GB")) return value * 1_073_741_824L;
            if (normalized.endsWith("MB")) return value * 1_048_576L;
            if (normalized.endsWith("KB")) return value * 1024L;
            return value;
        } catch (Exception e) {
            return fallbackBytes;
        }
    }

    private static String humanWorkMem(long bytes) {
        if (bytes % 1_073_741_824L == 0 && bytes >= 1_073_741_824L) {
            return (bytes / 1_073_741_824L) + "GB";
        }
        if (bytes % 1_048_576L == 0 && bytes >= 1_048_576L) {
            return (bytes / 1_048_576L) + "MB";
        }
        return Math.max(1, bytes / 1024L) + "kB";
    }

    private static String trimText(String s, int max) {
        if (s == null) return "";
        return s.length() > max ? s.substring(0, max) + "…" : s;
    }

    /**
     * Top sorgu/tablo/index listesinden bildirim mesajına eklenecek kısa özet üretir.
     * Her satır: "sorgu_metni (50 kar) → şu_anki (önceki, %artış)"
     * Context'e "top_queries_summary" olarak konur, template'de {{top_queries_summary}} ile kullanılır.
     */
    private static String buildTopSummaryText(List<Map<String, Object>> records, String metricType) {
        if (records == null || records.isEmpty()) return "";
        StringBuilder sb = new StringBuilder();
        int limit = Math.min(records.size(), 5);
        for (int i = 0; i < limit; i++) {
            Map<String, Object> r = records.get(i);
            if (i > 0) sb.append("\n");
            sb.append(i + 1).append(". ");

            // Sorgu/tablo/index adı
            String label;
            switch (metricType) {
                case "statement_metric" -> label = trimText((String) r.get("query_text"), 50);
                case "table_metric"     -> label = r.get("schemaname") + "." + r.get("relname");
                case "index_metric"     -> label = r.get("schemaname") + "." + r.get("indexrelname");
                default                 -> label = "?";
            }
            sb.append("`").append(label).append("`");

            // Değerler: şu anki (önceki → artış%)
            Object currentVal = r.get("current_val");
            Object prevVal = r.get("prev_val");
            Object changePct = r.get("change_pct");
            if ("statement_metric".equals(metricType)) {
                Object seriesId = r.get("statement_series_id");
                if (seriesId != null) {
                    sb.append(" | detay: `/statements/").append(seriesId).append("`");
                }
                Object callsWindow = r.get("calls_window");
                Object calls28d = r.get("calls_28d");
                Object activeDays28d = r.get("active_days_28d");
                if (callsWindow != null || calls28d != null) {
                    sb.append(" | siklik: pencere=").append(formatNumOrZero(callsWindow))
                      .append(", 28g=").append(formatNumOrZero(calls28d));
                    if (activeDays28d != null) {
                        sb.append(", aktif gun=").append(formatNumOrZero(activeDays28d));
                    }
                }
            }

            if (currentVal != null) {
                sb.append(" → **").append(formatNum(currentVal)).append("**");
                if (prevVal != null) {
                    sb.append(" (önceki: ").append(formatNum(prevVal));
                    if (changePct != null) {
                        double pct = ((Number) changePct).doubleValue();
                        sb.append(", ").append(pct >= 9999 ? "yeni" : "%" + Math.round(pct));
                    }
                    sb.append(")");
                }
            }
        }
        if (records.size() > 5) {
            sb.append("\n... ve ").append(records.size() - 5).append(" sorgu daha");
        }
        return sb.toString();
    }

    private static String formatNumOrZero(Object val) {
        if (!(val instanceof Number)) return "0";
        return formatNum(val);
    }

    private static String formatNum(Object val) {
        if (val == null) return "0";
        double d = ((Number) val).doubleValue();
        if (d >= 1_000_000) return String.format("%.1fM", d / 1_000_000);
        if (d >= 1_000) return String.format("%.1fK", d / 1_000);
        return String.format("%.0f", d);
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
                    "select ss.statement_series_id, ss.queryid, ss.dbid, ss.userid," +
                    "       sum(d." + toFactColumn(metricName, "statement_metric") + ")::numeric as current_val," +
                    "       left(coalesce(qt.query_text, '?'), 300) as query_text," +
                    "       dbr.datname, rr.rolname" +
                    "  from fact.pgss_delta d" +
                    "  join dim.statement_series ss on ss.statement_series_id = d.statement_series_id" +
                    "  left join dim.query_text qt on qt.query_text_id = ss.query_text_id" +
                    "  left join dim.database_ref dbr on dbr.instance_pk = ss.instance_pk and dbr.dbid = ss.dbid" +
                    "  left join dim.role_ref    rr  on rr.instance_pk  = ss.instance_pk and rr.userid  = ss.userid" +
                    "  where d.instance_pk = ? and d.sample_ts > now() - ?::interval" +
                    "  group by ss.statement_series_id, ss.queryid, ss.dbid, ss.userid, qt.query_text, dbr.datname, rr.rolname" +
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
                String metricFilter = parts.length > 3 ? " and metric_name = ?" : "";
                String sql = "select max(" + col + ")::numeric as mx, min(" + col + ")::numeric as mn, count(*) as cnt" +
                    " from " + table +
                    " where instance_pk = ?" + metricFilter +
                    " and " + timeCol + " >= now() - ?::interval";
                Map<String, Object> stats = parts.length > 3
                    ? jdbc.queryForMap(sql, instancePk, parts[3], flatlineMinutes + " minutes")
                    : jdbc.queryForMap(sql, instancePk, flatlineMinutes + " minutes");

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
            String metricFilter = parts.length > 3 ? " and metric_name = ?" : "";
            String sql = "select " + extremeFn + "(computed_value) from (" +
                "  select " + aggFn + "(" + parts[1] + ") as computed_value" +
                "  from " + parts[0] +
                "  where instance_pk = ?" + metricFilter +
                "    and " + parts[2] + " < now() - ?::interval" +
                "  group by date_trunc('hour', " + parts[2] + ")" +
                ") sub";
            if (parts.length > 3) {
                return jdbc.queryForObject(
                    sql, BigDecimal.class, instancePk, parts[3], excludeLastMinutes + " minutes");
            }
            return jdbc.queryForObject(
                sql, BigDecimal.class, instancePk, excludeLastMinutes + " minutes");
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
            case "cluster_metric.wal_bytes"              -> "fact.pg_cluster_delta|metric_value_num|sample_ts|wal_bytes";
            case "cluster_metric.checkpoint_write_time"  -> "fact.pg_cluster_delta|metric_value_num|sample_ts|checkpoint_write_time";
            case "cluster_metric.buffers_checkpoint"     -> "fact.pg_cluster_delta|metric_value_num|sample_ts|buffers_checkpoint";
            case "cluster_metric.checkpoints_timed"      -> "fact.pg_cluster_delta|metric_value_num|sample_ts|checkpoints_timed";
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
            String metricFilter = "cluster_metric".equals(metricType) ? " and metric_name = ?" : "";
            String sql = "select count(distinct date_trunc('day', " + getTimeColumn(metricType) + "))" +
                " from " + table + " where instance_pk = ?" + metricFilter +
                " and " + getTimeColumn(metricType) + " >= now() - ?::interval";
            Integer count = "cluster_metric".equals(metricType)
                ? jdbc.queryForObject(sql, Integer.class, instancePk, metricName, minDataDays + " days")
                : jdbc.queryForObject(sql, Integer.class, instancePk, minDataDays + " days");
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
            "select instance_pk, " + aggFn + "(metric_value_num) as value" +
            " from fact.pg_cluster_delta" +
            " where metric_name = ? and sample_ts >= now() - ?::interval" +
            " group by instance_pk",
            metricName, interval);
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
            "select instance_pk, " + aggFn + "(metric_value_num) as value" +
            " from fact.pg_cluster_delta" +
            " where metric_name = ?" +
            " and sample_ts between now() - ?::interval and now() - ?::interval" +
            " group by instance_pk",
            metricName, intervalStart, intervalEnd);
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
        // statement_metric.avg_exec_time_ms — pgss_delta'da bu kolon yok,
        // total_exec_time_ms_delta ile karşılığı tutulur. Adaptive baseline
        // sum(total_exec_time_ms_delta) bazlı çalışır; "avg" semantiği
        // baseline farkıyla tutarlı kalır (rate of change).
        if ("statement_metric".equals(metricType) && "avg_exec_time_ms".equals(safe)) {
            return "total_exec_time_ms_delta";
        }
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
