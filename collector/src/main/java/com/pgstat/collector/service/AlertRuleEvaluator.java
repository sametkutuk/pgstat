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
     * Bir kanit alaninin neden kullanilabilir/kullanilamaz oldugunu anlatir.
     * Tek bir enum tum kanitlari temsil EDEMEZ — ornegin PG12'de IO-wait
     * kanidi AVAILABLE iken throttle kanidi UNSUPPORTED_VERSION olur; ya da
     * 9 farkli snapshot varken oranlar INSUFFICIENT_DATA iken guncel worker
     * sayisi hala AVAILABLE'dir. Bu yuzden AutovacuumWorkerEvidence dort
     * ayri status alani tasir.
     * Tasarim: docs/autovacuum-cost-diagnosis-design.md
     */
    enum EvidenceStatus {
        /** Deger var ve yorumlanabilir. */
        AVAILABLE,
        /** Veri var ama yeterlilik kapisini (>=10 distinct snapshot) gecmiyor. */
        INSUFFICIENT_DATA,
        /** Tazelik esigi icinde hic snapshot yok. */
        NO_FRESH_SNAPSHOT,
        /** Bu PG surumu bu sinyali hic uretmiyor (orn. VacuumDelay PG13 oncesi). */
        UNSUPPORTED_VERSION,
        /** Instance'in pg_major'i bilinmiyor — desteklenip desteklenmedigi belirsiz. */
        UNKNOWN_VERSION,
        /** Ilgili ayar toplanmamis/bayat (kapasite hesabi icin). */
        UNKNOWN,
        /** Bu PG surumu icin anlamsiz (orn. worker_slots PG18 oncesi). */
        NOT_APPLICABLE
    }

    /**
     * Autovacuum worker gozlem kaniti — Teshis 2 (IO bekleme) ve Teshis 2b
     * (throttle uykusu) tek sorgudan beslenir.
     *
     * Kova matematigi: uc adlandirilmis kova + residual, tanimi geregi
     * totalSamples'a esittir (otherWaitSamples fark olarak hesaplanir).
     * "Worker ya aktif ya throttle'da" iki kutuplu modeli YANLIS — worker
     * Lock/BufferPin/LWLock gibi baska wait'lerde de bekleyebilir.
     */
    record AutovacuumWorkerEvidence(
        Integer runningWorkers,
        Integer maxWorkers,
        Integer workerSlots,
        Integer effectiveWorkerCapacity,
        long totalSamples,
        int distinctSnapshots,
        long ioWaitSamples,
        Long throttleSleepSamples,
        long noWaitEventSamples,
        long otherWaitSamples,
        EvidenceStatus currentWorkerStatus,
        EvidenceStatus ioWaitStatus,
        EvidenceStatus throttleStatus,
        EvidenceStatus capacityStatus
    ) {
        /** Hicbir kanit okunamadiginda donulen bos kayit. */
        static AutovacuumWorkerEvidence unknown() {
            return new AutovacuumWorkerEvidence(
                null, null, null, null, 0L, 0, 0L, null, 0L, 0L,
                EvidenceStatus.UNKNOWN_VERSION, EvidenceStatus.UNKNOWN_VERSION,
                EvidenceStatus.UNKNOWN_VERSION, EvidenceStatus.UNKNOWN);
        }

        /** IO-wait orani (0-100). Sadece ioWaitStatus == AVAILABLE ise anlamli. */
        double ioWaitPct() {
            return totalSamples == 0 ? 0.0 : 100.0 * ioWaitSamples / totalSamples;
        }

        /** Throttle uykusu orani (0-100). Sadece throttleStatus == AVAILABLE ise anlamli. */
        double throttleSleepPct() {
            return totalSamples == 0 || throttleSleepSamples == null
                ? 0.0 : 100.0 * throttleSleepSamples / totalSamples;
        }
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

    /**
     * Bir alert'i cozuldu olarak isaretler VE bildirim kanalina "Resolved: ..."
     * mesaji gonderir. Eskiden alertRepo.resolve(alertKey) sadece DB durumunu
     * guncelliyordu, hicbir yerde bildirim gitmiyordu — musteri raporu
     * (2026-08-21): dead_tuple_ratio alert'i dogru sekilde resolve oluyordu
     * ama Telegram'a "cozuldu" bildirimi hic gelmiyordu, sadece yeni WARNING/
     * CRITICAL bildirimleri goruluyordu. Title/message, tam olarak orijinal
     * alert'in son mesajini yeniden uretmeye calismaz (context her cagri
     * yerinde farkli/eksik olabilir) — jenerik ama tanimlayici bir ozet
     * yeterli, cunku resolveAndNotify zaten "Resolved: " onekini otomatik
     * ekliyor.
     */
    private void resolveAlert(String alertKey, Map<String, Object> rule, long instancePk) {
        resolveAlert(alertKey, rule, instancePk, null);
    }

    /**
     * exceeding.isEmpty() dalinda (artik esigi asan hicbir kayit yok) resolve
     * bildirimine hangi tablo(lar)in duzeldigini eklemek icin, o alert'in EN
     * SON acik halindeki details_json'undaki (buildPerRecordsJson ile yazilan
     * "records" dizisi) kayit etiketlerini okur. Musteri talebi (2026-08-24):
     * "hangi tablo resolve olduysa resolve mesajinda o sema ve tablo adi
     * olmali" — birden fazla tablo ayni anda duzelmis olsa da hepsi listelenir.
     * details_json yoksa/parse edilemezse null doner (resolveAlert generic
     * etikete duser).
     */
    private String previousRecordsLabel(String alertKey, String metricType) {
        try {
            // DB=... oneki, ayni sema.tablo adinin farkli database'lerde
            // ayri anlam tasiyabilecegini net etmek icin (musteri talebi
            // 2026-08-24: "hangi database'de oldugunu gostermemiz o da cok
            // onemli").
            // Not: r->>'x' ifadeleri parantez icine alinmali — parantezsiz
            // hali ("r->>'schemaname' || '.' || r->>'relname'") calisma
            // zamaninda "operator does not exist: text ->> unknown" hatasi
            // veriyordu (musteri raporu 2026-08-24: bazi resolve mesajlarinda
            // tablo adi hic gorunmuyordu — bu sorgu exception firlatip catch
            // blogunda sessizce null donuyordu).
            String labelExpr = switch (metricType) {
                case "table_metric" -> "'DB=' || coalesce((r->>'datname'), 'bilinmiyor') || ' ' || (r->>'schemaname') || '.' || (r->>'relname')";
                case "index_metric" -> "'DB=' || coalesce((r->>'datname'), 'bilinmiyor') || ' ' || (r->>'schemaname') || '.' || (r->>'indexrelname')";
                case "statement_metric" -> "'DB=' || coalesce((r->>'datname'), 'bilinmiyor') || ' queryid=' || (r->>'queryid')";
                default -> null;
            };
            if (labelExpr == null) return null;

            List<String> labels = jdbc.queryForList(
                "select distinct " + labelExpr + " as lbl " +
                "from ops.alert, jsonb_array_elements(details_json->'records') r " +
                "where alert_key = ? and details_json is not null " +
                "order by 1 limit 5",
                String.class, alertKey);
            if (labels.isEmpty()) return null;
            return String.join(", ", labels);
        } catch (Exception e) {
            log.debug("previousRecordsLabel okunamadi alertKey={}: {}", alertKey, e.getMessage());
            return null;
        }
    }

    /**
     * Per-record kaydin (tablo/sorgu/index) okunabilir etiketi — resolve
     * bildiriminde kullanilir. DB=... oneki dahil — ayni sema.tablo adi farkli
     * database'lerde ayri anlam tasiyabilir (musteri talebi 2026-08-24).
     */
    /**
     * Granular (per-record) kurallarda bir instance'in TUM kayitlarinin ortak
     * alert_key oneki. Bu instance icin acik kalmis ama artik esigi asmayan
     * kayitlarin alert'lerini bulup kapatmak icin kullanilir.
     */
    static String recordAlertKeyPrefix(long ruleId, long instancePk) {
        return "rule:" + ruleId + ":instance:" + instancePk + ":rec:";
    }

    /**
     * Bir kaydin kendi alert anahtari.
     *
     * Eskiden granular kurallar instance basina TEK anahtar kullaniyordu
     * ("rule:14:instance:2") ve sadece listenin ilk kaydi degerlendiriliyordu;
     * ayni instance'taki diger bozuk tablolar hic gorunmuyordu. Uretimde
     * (2026-08-28, instance 2) security.user 3250 olu satirla listenin basinda
     * ama %11 oraniyla esigin ALTINDA oldugu icin hicbir alert acilmiyor, onun
     * altindaki user_token (%55.2), t_ext_hotel_content_general (%93.6),
     * t_ext_hotel_quota_room (%74.9) ve approve_queue (%92.6) hic
     * degerlendirilmiyordu — ucu kritik esigin ustunde.
     *
     * Anahtar, kaydi tekil olarak tanimlayan alanlardan kurulur; boylece her
     * tablo/index/sorgu kendi alert'ini acar, gunceller ve bagimsiz kapanir.
     * dbid her tipte yer alir cunku ayni sema.tablo adi farkli veritabanlarinda
     * farkli nesnelerdir (uretimde t_currency_rate_active hem public hem engine
     * seemasinda ve iki ayri DB'de vardi).
     *
     * relid varsa tercih edilir (yeniden adlandirmaya dayanikli); yoksa
     * sema.ad kullanilir — generic table_metric ve index_metric sorgulari
     * relid secmiyor.
     */
    static String recordAlertKey(long ruleId, long instancePk,
                                  Map<String, Object> record, String metricType) {
        String prefix = recordAlertKeyPrefix(ruleId, instancePk);
        Object dbid = record.get("dbid");
        String dbPart = "db:" + (dbid != null ? dbid : "?");
        return switch (metricType) {
            case "table_metric" -> {
                Object relid = record.get("relid");
                yield prefix + dbPart + (relid != null
                    ? ":rel:" + relid
                    : ":tbl:" + record.get("schemaname") + "." + record.get("relname"));
            }
            case "index_metric" -> prefix + dbPart
                + ":idx:" + record.get("schemaname") + "." + record.get("indexrelname");
            case "statement_metric" -> prefix + dbPart
                + ":series:" + record.get("statement_series_id");
            // Bilinmeyen tip: instance basina tek anahtara duser (eski davranis).
            // Yeni bir granular tip eklenirse burasi bilinclice guncellenmeli.
            default -> prefix + "unknown";
        };
    }

    private static String recordLabel(Map<String, Object> record, String metricType) {
        String db = "DB=" + (record.get("datname") != null ? record.get("datname") : "?") + " ";
        return switch (metricType) {
            case "table_metric" -> db + record.get("schemaname") + "." + record.get("relname");
            case "index_metric" -> db + record.get("schemaname") + "." + record.get("indexrelname");
            case "statement_metric" -> {
                Object seriesId = record.get("statement_series_id");
                yield seriesId != null ? db + "queryid=" + record.get("queryid") : null;
            }
            default -> null;
        };
    }

    /**
     * detail: granular (per-record) kurallarda hangi tablo/sorgu/index'in
     * duzeldigini belirtir (orn. "public.t_currency_rate_active") — musteri
     * geri bildirimi (2026-08-24): "cozuldu" bildirimi sadece instance adini
     * gosteriyordu, hangi tablonun duzeldigi belirsizdi. null ise (instance/job
     * bazli alertler gibi granular olmayan durumlar) title'a eklenmez.
     */
    private void resolveAlert(String alertKey, Map<String, Object> rule, long instancePk, String detail) {
        String ruleName = (String) rule.get("rule_name");
        String metricType = (String) rule.get("metric_type");
        String metricName = (String) rule.get("metric_name");
        String instanceName = lookupInstanceName(instancePk);
        String title = detail != null && !detail.isBlank()
            ? String.format("%s - %s (%s)", instanceName, ruleName, detail)
            : String.format("%s - %s", instanceName, ruleName);
        String message = String.format("Metrik %s.%s tekrar normal seviyede.", metricType, metricName);
        alertRepo.resolveAndNotify(alertKey, title, message);
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
        log.info("AlertRuleEvaluator evaluate cycle: {} aktif kural", rules.size());
        if (rules.isEmpty()) return;
        for (Map<String, Object> rule : rules) {
            try {
                log.info("Kural degerlendiriliyor rule_id={} type={} metric={}.{}",
                    rule.get("rule_id"), rule.get("evaluation_type"),
                    rule.get("metric_type"), rule.get("metric_name"));
                evaluateRule(rule);
            } catch (Exception e) {
                log.error("Kural degerlendirme hatasi rule_id={}: {}", rule.get("rule_id"), e.getMessage(), e);
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

            // Gate A/B/C — istatistik sinyali + pratik anlam kontrolu
            // (database_metric icin loadBaseline'dan gelen avg/stddev kullanilir,
            //  MAD CTE'lerine cevirmiyoruz cunku baseline tablosu zaten nightly hesaplaniyor)
            BigDecimal classFloor = getMetricClassFloor(metricName);
            BigDecimal userThreshold = toBD(rule.get("warning_threshold"));
            BigDecimal effectiveFloor = (userThreshold != null && userThreshold.signum() > 0)
                ? userThreshold : classFloor;
            BigDecimal pctChangeGate = new BigDecimal("0.50");

            // Gate A: baseline >= class floor (gurultu degil)
            if (avg.compareTo(classFloor) < 0) {
                updateLastEval(ruleId, instancePk, current, null);
                continue;
            }
            // Gate B: current >= effective floor
            if (current.compareTo(effectiveFloor) < 0) {
                updateLastEval(ruleId, instancePk, current, null);
                continue;
            }
            // Gate C: en az %50 artis
            BigDecimal diff = current.subtract(avg);
            if (avg.signum() > 0 && diff.compareTo(avg.multiply(pctChangeGate)) < 0) {
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
                resolveAlert(alertKey, rule, instancePk);
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
                if (prevSeverity != null && autoResolve) resolveAlert(alertKey, rule, instancePk);
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
                    resolveAlert(alertKey, rule, instancePk);
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
                resolveAlert(alertKey, rule, instancePk);
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
                resolveAlert(alertKey, rule, instancePk);
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
                resolveAlert(alertKey, rule, instancePk);
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
                resolveAlert(alertKey, rule, instancePk);
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

                if (prevSeverity != null && autoResolve) resolveAlert(alertKey, rule, instancePk);
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
                        "            else round(((c.current_val - p.prev_val) * 100.0 / nullif(p.prev_val, 0))::numeric, 1) end as change_pct," +
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
                        "            else round(((c.current_val - p.prev_val) * 100.0 / nullif(p.prev_val, 0))::numeric, 1) end as change_pct," +
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
            // Her kayit kendi alert'ini alir; bu onek o instance'in tum
            // kayit-alert'lerini bulmaya yarar (bkz. recordAlertKey).
            String keyPrefix = recordAlertKeyPrefix(ruleId, instancePk);

            // Esigi asan kayitlari bul (max threshold = warning, critical varsa hari)
            BigDecimal probeThreshold = warningThreshold != null ? warningThreshold : criticalThreshold;
            if (probeThreshold == null) continue;

            // dead_tuple_ratio icin uc bacakli override'lar (bkz. AlertRuleEvaluator
            // findBloatedTables): kullanici alert_rule'da deger girmemisse (NULL)
            // kod tarafinda best-practice default kullanilir.
            Long bloatMinRows = toLongOrNull(rule.get("bloat_min_rows"));
            Long bloatAbsDeadTup = toLongOrNull(rule.get("bloat_abs_dead_tup"));
            Integer bloatVacuumIneffectiveCount = toIntOrNull(rule.get("bloat_vacuum_ineffective_count"));

            List<Map<String, Object>> exceeding = findRecordsExceedingThreshold(
                instancePk, metricType, metricName, windowMinutes, operator, probeThreshold,
                bloatMinRows, bloatAbsDeadTup, bloatVacuumIneffectiveCount);

            // Sorgular LIMIT+1 ceker: fazlasi varsa kirpma OLDUGU anlasilir.
            // Kirpilan kayitlar sessizce yutulmaz, loglanir — aksi halde
            // "bu instance'ta N sorun var" mesaji eksik oldugu belli olmadan
            // tam gibi okunur.
            if (exceeding.size() > PER_RECORD_QUERY_LIMIT) {
                log.warn("Granular alert kirpildi: rule={} instance={} metric={} — esigi asan"
                        + " kayit sayisi {} sinirinin uzerinde, sadece en ciddi {} tanesi"
                        + " degerlendirildi",
                    ruleId, instancePk, metricName, PER_RECORD_QUERY_LIMIT, PER_RECORD_QUERY_LIMIT);
                exceeding = new java.util.ArrayList<>(exceeding.subList(0, PER_RECORD_QUERY_LIMIT));
            }

            enrichStatementRecords(instancePk, exceeding, metricType, windowMinutes);

            // Cooldown, YENI alert acilmasini geciktirir — ama zaten acik bir
            // alert'in mesaji her zaman guncellenir ve sorun duzelmisse resolve
            // her zaman calisir, cooldown'dan bagimsiz. Eskiden cooldown tum
            // mantigi atlayarak calisiyordu; bu iki hataya yol aciyordu: manuel
            // duzeltmelerin (orn. VACUUM) alert'i resolve etmesi 60dk
            // blokleniyordu (musteri raporu 2026-08-21) ve acik alert'in mesaji
            // donuyordu (2026-08-27, 2 saat boyunca artik gecerli olmayan bir
            // tabloyu gosterdi). Bildirim spam'i zaten NotificationService'te
            // alert bazinda ayrica korunuyor.
            boolean inCooldown = isInCooldown(ruleId, instancePk, cooldownMinutes);

            if (exceeding.isEmpty()) {
                // exceeding bos olmasi iki sebepten olabilir: (A) gercekten esigi
                // asan kayit yok — sorun duzelmis, resolve edilmeli, ya da (B) bu
                // instance'in normal toplama araligindaki boslukta evaluator
                // calisti, pencerede henuz hic ornek yok — bu durumda resolve
                // ETMEMELI, bir sonraki cycle'i beklemeli (musteri raporu
                // 2026-08-21: instance hala %99 bloat'liydi ama toplama araligi
                // bosluguna denk gelince yanlislikla resolve edildi).
                boolean hasData = hasRecentData(instancePk, metricType, windowMinutes);
                if (hasData && autoResolve) {
                    for (String openKey : alertRepo.openAlertKeysWithPrefix(keyPrefix)) {
                        resolveAlert(openKey, rule, instancePk, previousRecordsLabel(openKey, metricType));
                    }
                    updateLastEval(ruleId, instancePk, BigDecimal.ZERO, null);
                }
                continue;
            }

            // Her kayit ayri degerlendirilir. Eskiden sadece exceeding.get(0)
            // isleniyordu ve ayni instance'taki diger bozuk kayitlar hic
            // gorunmuyordu (bkz. recordAlertKey javadoc'undaki uretim vakasi).
            java.util.Set<String> stillAlerting = new java.util.HashSet<>();
            java.util.List<RaisedRecordAlert> raised = new java.util.ArrayList<>();
            // updateLastEval instance bazli kalir (API'deki AlertRules sayfasi ve
            // baseline cache oradan okuyor) — en ciddi kaydin degeri yazilir.
            BigDecimal worstVal = null;
            String worstSeverity = null;

            for (Map<String, Object> record : exceeding) {
                String recordKey = recordAlertKey(ruleId, instancePk, record, metricType);
                BigDecimal currentVal = toBDSafe(record.get("current_val"));
                String severity = determineSeverity(currentVal, operator, warningThreshold, criticalThreshold);
                String prevSeverity = alertRepo.openSeverity(recordKey);
                if (worstVal == null) worstVal = currentVal;

                if (severity == null) {
                    if (prevSeverity != null && autoResolve) {
                        resolveAlert(recordKey, rule, instancePk, recordLabel(record, metricType));
                    }
                    continue;
                }
                if (worstSeverity == null || isMoreSevere(severity, worstSeverity)) {
                    worstSeverity = severity;
                    worstVal = currentVal;
                }
                // Cooldown yalnizca YENI alert acilmasini engeller; zaten acik olan
                // guncellenmeye devam eder ki mesaji donmasin.
                if (inCooldown && prevSeverity == null) continue;
                BigDecimal threshold = "critical".equals(severity) ? criticalThreshold : warningThreshold;

                Map<String, Object> ctx = baseContext(rule, instancePk, severity);
                ctx.put("value", currentVal);
                ctx.put("current_value", currentVal);
                ctx.put("threshold", threshold);
                ctx.put("window", windowMinutes);
                populateRecordCtx(ctx, record, metricType);

                // dead_tuple_ratio icin kanita dayali teshis+aksiyon (PGSTAT-P0-036
                // AC6, bkz. docs/bloat-diagnosis-decision-tree.md) — sabit "tablo
                // istatistiklerine ve autovacuum/index ihtiyacina bak" yerine.
                // Diger table_metric kurallari icin sablon bu placeholder'lari
                // kullanmiyor (V092 sadece table_threshold'u degistirdi), ama
                // ileride kullanilirsa bos satir gorunmesin diye jenerik fallback
                // her zaman set edilir.
                if ("dead_tuple_ratio".equals(metricName)) {
                    BloatDiagnosis diagnosis = diagnoseBloat(record, instancePk);
                    // "Autovacuum henuz yetismemis olabilir" durumu cogu zaman
                    // toplama anina denk gelmis gecici bir birikimdir ve kendi
                    // kendine duzelir — israr etmedigi surece alert acmiyoruz
                    // (musteri talebi 2026-08-27). Kacirma riski yok: gercekten
                    // yetisemeyen tablolar karar agacinda DAHA ONCE gelen
                    // senaryo 2/3/3.5/4.5'e takilir ve aninda alert uretir.
                    if (diagnosis.suppressAlert()) {
                        log.debug("Bloat alert bastirildi (gecici birikim, israr esigi asilmadi): {}.{} instance={}",
                            record.get("schemaname"), record.get("relname"), instancePk);
                        // severity DEGIL null yazilir. Bastirma "su an alert yok"
                        // demektir; severity yazmak iki sey bozuyordu:
                        //  1) last_alert_at = now() olup cooldown'u tetikliyor, boylece
                        //     bastirma kalktiginda bile alert 60dk daha acilamiyordu,
                        //  2) current_severity dolu kaldigi icin bir sonraki cycle'da
                        //     resolve kosulu (prevSeverity != null) yaniltici sekilde
                        //     sagleniyordu.
                        // Zaten ACIK bir alert varsa bastirma onu oldugu gibi
                        // birakmamali. Bastirmanin amaci YENI alert acmamakti
                        // (musteri talebi 2026-08-27: "birazdan calisacak diyor,
                        // alert olarak vermeyelim"); ama acik bir alert guncellenmeden
                        // birakilinca zombi hale geliyordu: uretimde alert 21 Agustos'ta
                        // acilmis, sonra bastirma devreye girmis ve mesaj 2 saat boyunca
                        // artik gecerli olmayan bir tabloyu gostermeye devam etmisti
                        // (kullanici o tabloyu VACUUM'lamis, alert hala onu yaziyordu).
                        // Bastirilan durum "alert edilecek kadar ciddi degil" demek
                        // oldugundan, acik alert varsa kapatilir.
                        if (prevSeverity != null && autoResolve) {
                            resolveAlert(recordKey, rule, instancePk, recordLabel(record, metricType));
                        }
                        continue;
                    }
                    ctx.put("diagnosis", "Teşhis: " + diagnosis.diagnosis() + "\n");
                    ctx.put("bloat_action", diagnosis.action());
                } else {
                    ctx.put("diagnosis", "");
                    ctx.put("bloat_action", "Tablo istatistiklerine ve autovacuum/index ihtiyacına bak.");
                }

                // Fallback mesaja da teshis/aksiyon eklenir: template render
                // basarisiz olursa (kod bulunamadi/placeholder hatasi) eskiden
                // sadece jenerik "Tablo esigi asti: ..." satiri kaliyordu ve
                // diagnoseBloat()'un urettigi tum kanit sessizce kayboluyordu
                // (PGSTAT-P1-011 kod onkosulu 4).
                String fallbackMsg = appendDiagnosisToFallback(
                    buildPerRecordThresholdMessage(metricType, metricName, record,
                        operator, threshold, windowMinutes),
                    ctx);
                // details_json artik SADECE bu kaydi tasir — alert kayit bazli
                // oldugu icin "hangi kayit duzeldi" bilgisi de kayit bazli olmali
                // (previousRecordsLabel bu diziyi okuyor).
                String detailsJson = buildPerRecordsJson(java.util.List.of(record), metricType,
                    windowMinutes, threshold.toPlainString(), "exceeding_threshold");

                // Template kodu: granular tip icin uygun statement_spike-benzeri code,
                // yoksa user_defined_rule
                String alertCodeForTemplate = templateCodeForType(metricType, "threshold");
                String[] rendered = renderWithCode(rule, ctx, ruleName, fallbackMsg, alertCodeForTemplate);

                // DEFERRED: bildirim burada gitmez. Bes bozuk tablo bes ayri
                // ops.alert satiri olusturur ama tek ozet bildirim gonderilir
                // (musteri karari 2026-08-28) — dongu bitince asagida.
                long alertId = alertRepo.upsertWithSeverity(recordKey, AlertCode.USER_DEFINED_RULE,
                    severity, instancePk, serviceGroup, rendered[0], rendered[1], ruleId, detailsJson,
                    AlertRepository.NotifyMode.DEFERRED);

                stillAlerting.add(recordKey);
                raised.add(new RaisedRecordAlert(alertId, recordKey, severity,
                    recordLabel(record, metricType), currentVal, threshold, rendered[0]));
            }

            // Bu degerlendirmede artik esigi asmayan kayitlarin alert'lerini
            // kapat. Kayit listeden dustugu icin yukaridaki dongu ona hic
            // ugramaz; bu adim olmazsa duzelen bir tablonun alert'i sonsuza
            // kadar acik kalirdi.
            if (autoResolve) {
                for (String openKey : alertRepo.openAlertKeysWithPrefix(keyPrefix)) {
                    if (!stillAlerting.contains(openKey)) {
                        resolveAlert(openKey, rule, instancePk, previousRecordsLabel(openKey, metricType));
                    }
                }
            }

            notifyRaisedBatch(raised, instancePk, ruleName);
            updateLastEval(ruleId, instancePk, worstVal, worstSeverity);
        }
    }

    /**
     * Bir degerlendirmede acilan tek bir kayit-alert'i (ozet bildirim icin).
     * message tasinmiyor: bildirim kisa tutuluyor, tam metin ops.alert'te.
     */
    private record RaisedRecordAlert(long alertId, String alertKey, String severity,
                                      String label, BigDecimal value, BigDecimal threshold,
                                      String title) {}

    /** severity siralamasi: critical > error > warning > info. */
    private static boolean isMoreSevere(String candidate, String current) {
        return severityRank(candidate) > severityRank(current);
    }

    private static int severityRank(String severity) {
        if (severity == null) return -1;
        return switch (severity) {
            case "critical" -> 3;
            case "error"    -> 2;
            case "warning"  -> 1;
            case "info"     -> 0;
            default -> -1;
        };
    }

    /**
     * Bir degerlendirmede acilan kayit-alert'leri icin TEK, KISA bildirim.
     *
     * Kayit basina alert acmak dogru, ama kayit basina bildirim gondermek
     * degil: uretimde tek bir instance'ta ayni anda bes tablo esigin ustundeydi
     * ve bu bes ayri Telegram mesaji demek olurdu. Musteri karari (2026-08-28):
     * "alert ayri ayri acilsin, bildirim tek ozet mesajda toplansin".
     *
     * Bildirim bilincli olarak KISA: baslik + hangi nesne + hangi deger. Tam
     * teshis ve aksiyon metni ops.alert'te duruyor ve UI'da goruluyor —
     * musteri talebi (2026-08-28): "telegram alertleri baslik ve cok kisa ozet
     * olmali, detayi UI'dan gorebilmeliyim". Bu, tek kayitlik bildirimler icin
     * de gecerli: eskiden alert'in tum govdesi (teshis + aksiyon paragraflari)
     * oldugu gibi gonderiliyordu.
     */
    private void notifyRaisedBatch(java.util.List<RaisedRecordAlert> raised,
                                    long instancePk, String ruleName) {
        if (raised.isEmpty()) return;

        // Bildirim, gruptaki en ciddi alert'e baglanir: NotificationService'in
        // spam korumasi, snooze ve bakim penceresi kontrolleri alert_id/alert_key
        // uzerinden calisiyor.
        RaisedRecordAlert worst = raised.get(0);
        for (RaisedRecordAlert r : raised) {
            if (isMoreSevere(r.severity(), worst.severity())) worst = r;
        }

        String title;
        String body;
        if (raised.size() == 1) {
            // Alert'in kendi basligi zaten instance ve nesne adini tasiyor
            // (sablondan gelir); govde tek satira iner.
            title = worst.title();
            body = summaryLine(worst);
        } else {
            title = String.format("%s — %s: %d kayit",
                lookupInstanceName(instancePk), ruleName, raised.size());
            StringBuilder sb = new StringBuilder();
            int shown = 0;
            for (RaisedRecordAlert r : raised) {
                if (shown++ >= BATCH_NOTIFICATION_LIST_LIMIT) break;
                sb.append("• ").append(summaryLine(r)).append('\n');
            }
            if (raised.size() > BATCH_NOTIFICATION_LIST_LIMIT) {
                sb.append(String.format("… ve %d kayit daha",
                    raised.size() - BATCH_NOTIFICATION_LIST_LIMIT));
            }
            body = sb.toString().stripTrailing();
        }

        alertRepo.notifySummary(worst.alertId(), worst.alertKey(),
            AlertCode.USER_DEFINED_RULE.getCode(), worst.severity(), instancePk,
            title, body);
    }

    /** Bildirimde bir kaydin tek satirlik ozeti: nesne — deger (esik). */
    private static String summaryLine(RaisedRecordAlert r) {
        String label = r.label() != null ? r.label() : r.alertKey();
        String value = r.value() != null ? formatValue(r.value()) : "?";
        return r.threshold() != null
            ? String.format("%s — %s (esik: %s)", label, value, formatValue(r.threshold()))
            : String.format("%s — %s", label, value);
    }

    /** Ozet bildirimde deger gosterimi — gereksiz ondalik basamak birakmaz. */
    private static String formatValue(BigDecimal value) {
        return value.stripTrailingZeros().scale() <= 0
            ? value.stripTrailingZeros().toPlainString()
            : value.setScale(2, java.math.RoundingMode.HALF_UP).toPlainString();
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
                // Bacak C (bkz. findBloatedTables): sadece dead_tuple_ratio icin doldurulur,
                // diger table_metric'lerde bu key hic yok, ctx'e null olarak yazilmaz.
                // vacuum_note: table_threshold sablonunda (V090) tam satir olarak
                // kullanilir — vacuum_ineffective true degilse bos string, boylece
                // sablonda "bos satir/anlamsiz placeholder" gorunmez.
                if (rec.containsKey("vacuum_ineffective")) {
                    boolean vacuumIneffective = Boolean.TRUE.equals(rec.get("vacuum_ineffective"));
                    ctx.put("vacuum_ineffective", vacuumIneffective);
                    ctx.put("vacuum_note", vacuumIneffective
                        ? "⚠️ Autovacuum çalışıyor ama yetişmiyor\n"
                        : "");
                } else {
                    ctx.put("vacuum_note", "");
                }
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

    /**
     * Bir instance'in ilgili fact tablosunda, verilen pencerede HIC satir olup
     * olmadigini kontrol eder — "esigi asan kayit yok" ile "toplama araligi
     * nedeniyle bu pencerede hic veri gelmedi" durumlarini ayirt etmek icin.
     *
     * Musteri raporu (2026-08-21): findBloatedTables() (ve benzer per-record
     * sorgular) sample_ts > now() - windowMinutes filtresi kullaniyor; eger
     * evaluator, bir instance'in normal toplama araligindaki (orn. 15-30dk)
     * bosluga denk gelen bir anda calisirsa, sorgu GECICI olarak bos doner —
     * bu, "sorun duzeldi" ile ayni gorunur ve yanlislikla auto-resolve tetikler.
     * Gercekte tablo hala %99 bloat'liydi, sadece bir sonraki ornek henuz
     * toplanmamisti. Bu kontrol, resolve'u sadece GERCEKTEN veri varken ve
     * esigi asmiyorken yapar; veri yoksa evaluator bir sonraki cycle'i bekler.
     */
    private boolean hasRecentData(long instancePk, String metricType, int windowMinutes) {
        try {
            String table = switch (metricType) {
                case "statement_metric" -> "fact.pgss_delta";
                case "table_metric"     -> "fact.pg_table_stat_delta";
                case "index_metric"     -> "fact.pg_index_stat_delta";
                default -> null;
            };
            if (table == null) return true; // bilinmeyen tip icin eski davranis (her zaman resolve edebilir)
            Integer count = jdbc.queryForObject(
                "select count(*) from " + table + " where instance_pk = ? and sample_ts > now() - ?::interval limit 1",
                Integer.class, instancePk, windowMinutes + " minutes");
            return count != null && count > 0;
        } catch (Exception e) {
            log.warn("hasRecentData kontrolu hatasi metricType={} instance={}: {}", metricType, instancePk, e.getMessage());
            return false; // hata durumunda resolve etmeyi engelle (guvenli taraf)
        }
    }

    /** Esigi asan top-N kaydi (per-record) granular metric tipinde */
    private List<Map<String, Object>> findRecordsExceedingThreshold(long instancePk,
                                                                    String metricType, String metricName,
                                                                    int windowMinutes, String operator,
                                                                    BigDecimal threshold,
                                                                    Long bloatMinRows, Long bloatAbsDeadTup,
                                                                    Integer bloatVacuumIneffectiveCount) {
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
                    "  order by current_val desc limit " + (PER_RECORD_QUERY_LIMIT + 1),
                    instancePk, windowMinutes + " minutes", threshold);

                case "table_metric" -> {
                    String col = toFactColumn(metricName, "table_metric");
                    if ("dead_tuple_ratio".equals(metricName)) {
                        yield findBloatedTables(instancePk, windowMinutes, op, threshold,
                            bloatMinRows, bloatAbsDeadTup, bloatVacuumIneffectiveCount);
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
                        "  order by current_val desc limit " + (PER_RECORD_QUERY_LIMIT + 1),
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
                        "  order by current_val desc limit " + (PER_RECORD_QUERY_LIMIT + 1),
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

    // Bloat/vacuum alert best-practice defaultlari (kullanici alert_rule'da
    // deger girmemisse, yani NULL ise, kullanilir). Piyasa arastirmasina
    // (check_postgres, Datadog, pganalyze, Citus) dayanir — bkz. mind-map
    // tasarim onayi 2026-08-21. Kucuk-ama-kritik sistem tablolarini (orn.
    // 592 satirlik ops.alert, %22 dead tuple) kacirmamak icin eski 1000
    // satirlik esik yerine cok daha kucuk bir min-rows (Bacak A) + satir
    // sayisindan tamamen bagimsiz mutlak esik (Bacak B) birlikte kullanilir.
    private static final long DEFAULT_BLOAT_MIN_ROWS = 100;
    private static final long DEFAULT_BLOAT_ABS_DEAD_TUP = 500;
    private static final int DEFAULT_BLOAT_VACUUM_INEFFECTIVE_COUNT = 20;

    /**
     * dead_tuple_ratio icin uc bacakli bloat tespiti — herhangi biri true olursa
     * tablo "esigi asan kayit" olarak doner:
     *   A) oran + minimum satir sayisi (mevcut mantigin devami, esik dusuruldu)
     *   B) mutlak dead-tuple sayisi (satir sayisindan bagimsiz)
     *   C) "vacuum_ineffective" — son pencerede cok sayida autovacuum calismis
     *      olup dead_tup hala yuksekse ayrica isaretlenir (context/mesaj notu,
     *      alert'i tek basina tetiklemez — A veya B zaten tetiklemis olmali).
     * Disk MB (nightly relation_size_snapshot) karara girmez, sadece bacak A/B
     * tetiklenirse UI/mesaj context'inde gosterilebilir (bu metodun disinda).
     */
    private List<Map<String, Object>> findBloatedTables(long instancePk, int windowMinutes,
                                                          String op, BigDecimal threshold,
                                                          Long bloatMinRows, Long bloatAbsDeadTup,
                                                          Integer bloatVacuumIneffectiveCount) {
        long minRows = bloatMinRows != null ? bloatMinRows : DEFAULT_BLOAT_MIN_ROWS;
        long absDeadTup = bloatAbsDeadTup != null ? bloatAbsDeadTup : DEFAULT_BLOAT_ABS_DEAD_TUP;
        int vacuumIneffectiveCount = bloatVacuumIneffectiveCount != null
            ? bloatVacuumIneffectiveCount : DEFAULT_BLOAT_VACUUM_INEFFECTIVE_COUNT;

        return jdbc.queryForList(
            "select t.schemaname, t.relname, t.dbid, t.relid," +
            "       100.0 * t.n_dead_tup_estimate::numeric / nullif(t.n_live_tup_estimate + t.n_dead_tup_estimate, 0) as current_val," +
            "       t.n_dead_tup_estimate as dead_tup, t.n_live_tup_estimate as live_tup, dbr.datname," +
            "       (t.autovacuum_count_sum >= ? and t.n_dead_tup_estimate >= ?) as vacuum_ineffective," +
            "       t.last_autovacuum, t.last_vacuum, t.autovacuum_count_sum," +
            "       t.last_analyze, t.last_autoanalyze," +
            "       t.prev_dead_tup" +
            "  from (" +
            // n_dead_tup_estimate/n_live_tup_estimate pencerenin EN SON ornegine
            // (sample_ts en yuksek olan satir) ait olmali, max() degil — max()
            // kullanilirsa pencere icinde VACUUM/manuel temizlik oncesi gorulen
            // yuksek deger, temizlik sonrasi bile pencere kapanana kadar (30dk'ya
            // kadar) alert'i "hala kritik" gosterip resolve olmasini geciktirir
            // (musteri raporu 2026-08-21: VACUUM FULL sonrasi alert resolve olmadi).
            // autovacuum_count_sum ayrik kalir — o pencere boyunca KAC KEZ
            // autovacuum calistigini sayar, en son ornek degil toplam anlamli.
            // last_autovacuum/last_vacuum ve prev_dead_tup (trend icin onceki
            // ornek) teshis/aksiyon karar agacinda kullanilir (bkz.
            // docs/bloat-diagnosis-decision-tree.md, PGSTAT-P0-036 AC6).
            "    select distinct on (instance_pk, schemaname, relname, dbid)" +
            "           instance_pk, schemaname, relname, dbid, relid," +
            "           n_dead_tup_estimate, n_live_tup_estimate," +
            "           last_autovacuum, last_vacuum," +
            // Istatistik guvenilirlik kapisi icin (bkz. statsUntrustworthy):
            // n_live_tup/n_dead_tup sadece ANALYZE veya VACUUM sirasinda gercek
            // sayimla duzeltilir; hicbiri calismamissa sayaclardan turetilir ve
            // keyfi bicimde yanlis olabilir.
            "           last_analyze, last_autoanalyze," +
            "           sum(coalesce(autovacuum_count_delta, 0)) over (" +
            "             partition by instance_pk, schemaname, relname, dbid" +
            "           ) as autovacuum_count_sum," +
            "           lag(n_dead_tup_estimate) over (" +
            "             partition by instance_pk, schemaname, relname, dbid" +
            "             order by sample_ts" +
            "           ) as prev_dead_tup" +
            "      from fact.pg_table_stat_delta" +
            "     where instance_pk = ? and sample_ts > now() - ?::interval" +
            "     order by instance_pk, schemaname, relname, dbid, sample_ts desc" +
            "  ) t" +
            "  left join dim.database_ref dbr on dbr.instance_pk = t.instance_pk and dbr.dbid = t.dbid" +
            "  where (" +
            // Bacak A: oran + minimum satir sayisi
            "    (t.n_live_tup_estimate + t.n_dead_tup_estimate) >= ?" +
            "    and 100.0 * t.n_dead_tup_estimate::numeric / nullif(t.n_live_tup_estimate + t.n_dead_tup_estimate, 0) " + op + " ?" +
            "  ) or (" +
            // Bacak B: mutlak dead-tuple sayisi, satir sayisindan bagimsiz
            "    t.n_dead_tup_estimate >= ?" +
            "  )" +
            // Siralama MUTLAK dead_tup'a gore, current_val (oran) DEGIL —
            // musteri gozlemi 2026-08-25: kucuk bir tabloda %76 oran (83 olu
            // satir), 1.2M+ olu satirli buyuk bir agregasyon tablosunu (agg.
            // pg_table_stat_hourly, ~%17 oran) "top" konumundan itiyordu.
            // Gercek disk/performans etkisi mutlak satir sayisiyla orantili,
            // yuzdeyle degil — bu yuzden en cok etkiye sahip tablo alert
            // mesajinda gorunmeliydi ama gorunmedi.
            "  order by dead_tup desc nulls last limit " + (PER_RECORD_QUERY_LIMIT + 1),
            vacuumIneffectiveCount, absDeadTup,
            instancePk, windowMinutes + " minutes",
            minRows, threshold,
            absDeadTup
        );
    }

    /**
     * Instance'in global autovacuum ayarlarini fact.pg_settings_snapshot'tan
     * okur (gece toplanir, bkz. V039). Musteri talebi (2026-08-24): "kontrol
     * et" gibi belirsiz aksiyon onerileri yerine, elimizdeki gercek veriyle
     * KESIN teshis yapilmali — "autovacuum_enabled ayarini kontrol et" degil,
     * "canli/olu satir sayisina gore tetikleme esigi X coktan asilmis ama
     * global autovacuum='off'" gibi.
     * Tablo-duzeyinde autovacuum_enabled override'i (pg_class.reloptions) su an
     * toplanmiyor — bu yuzden global ayar kesin, tablo-ozel override kesin
     * degil; diagnoseBloat bunu acikca belirtir (bkz. docs/bloat-diagnosis-decision-tree.md).
     *
     * @return [autovacuumOn(Boolean), scaleFactor(BigDecimal), threshold(Long)] — degerler bulunamazsa null.
     */
    private Object[] fetchAutovacuumSettings(long instancePk) {
        try {
            List<Map<String, Object>> rows = jdbc.queryForList(
                "select distinct on (setting_name) setting_name, setting_value " +
                "from fact.pg_settings_snapshot " +
                "where instance_pk = ? and setting_name in " +
                "  ('autovacuum', 'autovacuum_vacuum_scale_factor', 'autovacuum_vacuum_threshold') " +
                "order by setting_name, snapshot_ts desc",
                instancePk);
            Boolean autovacuumOn = null;
            BigDecimal scaleFactor = null;
            Long threshold = null;
            for (Map<String, Object> row : rows) {
                String name = (String) row.get("setting_name");
                String value = (String) row.get("setting_value");
                switch (name) {
                    case "autovacuum" -> autovacuumOn = "on".equalsIgnoreCase(value);
                    case "autovacuum_vacuum_scale_factor" -> scaleFactor = new BigDecimal(value);
                    case "autovacuum_vacuum_threshold" -> threshold = Long.parseLong(value);
                }
            }
            return new Object[]{autovacuumOn, scaleFactor, threshold};
        } catch (Exception e) {
            log.debug("fetchAutovacuumSettings okunamadi instance={}: {}", instancePk, e.getMessage());
            return new Object[]{null, null, null};
        }
    }

    /**
     * Bir tablonun autovacuum_enabled override durumunu (pg_class.reloptions,
     * V093, control.table_relopts_snapshot) okur. "Olabilir" yerine KESIN
     * sonuc vermek icin — musteri talebi 2026-08-24: "bunu da kontrol
     * edebilirsin, neden autovacuum tetiklenmemis onu tespit et".
     *
     * @return FALSE ise override kapali (autovacuum_enabled=false), TRUE ise
     *         acik override var, null ise override yok/hic toplanmamis
     *         (varsayilan davranis: acik).
     */
    private Boolean fetchTableAutovacuumOverride(long instancePk, String schemaname, String relname) {
        try {
            List<Boolean> rows = jdbc.queryForList(
                "select autovacuum_enabled from control.table_relopts_snapshot " +
                "where instance_pk = ? and schemaname = ? and relname = ?",
                Boolean.class, instancePk, schemaname, relname);
            return rows.isEmpty() ? null : rows.get(0);
        } catch (Exception e) {
            log.debug("fetchTableAutovacuumOverride okunamadi instance={} table={}.{}: {}",
                instancePk, schemaname, relname, e.getMessage());
            return null;
        }
    }

    /**
     * Bir instance'ta uzun suredir acik bir transaction veya pasif
     * (active=false) bir replication slot var mi kontrol eder —
     * "autovacuum calisiyor ama xmin horizon engelliyor" senaryosunun kaniti
     * (bkz. docs/bloat-diagnosis-decision-tree.md, senaryo 2). Instance-genel
     * bir kontroldur (hangi transaction'in hangi tabloyu ENGELLEDIGI degil,
     * sadece "boyle bir risk var mi" sorusuna cevap verir).
     *
     * Iki kritik duzeltme (canli test, 2026-08-26 — ikisi de sahte pozitif
     * uretiyordu ve senaryo 2'yi haksiz yere senaryo 3/4.5'in onune
     * geciriyordu):
     *
     * 1. Transaction yasi SNAPSHOT ANINA gore olculur
     *    (snapshot_ts - xact_start), su ana gore DEGIL. Eski kod
     *    "xact_start < now() - 10 dakika" diyordu; 9 dakika once alinmis bir
     *    snapshot'taki 2 dakikalik bir transaction, simdi bakildiginda 11
     *    dakikalik gorunup sahte pozitif uretiyordu.
     * 2. backend_type = 'autovacuum worker' HARIC tutulur. Uzun suren bir
     *    VACUUM islemi "xmin horizon'u tutan uzun transaction" DEGILDIR;
     *    eski kod autovacuum'un kendi vacuum islemini sayip "autovacuum
     *    calisamiyor cunku autovacuum calisiyor" gibi anlamsiz bir teshis
     *    uretiyordu (canli ornek: "autovacuum: VACUUM av_test.churn").
     */
    private boolean hasXminHorizonRisk(long instancePk) {
        try {
            Integer count = jdbc.queryForObject(
                "select " +
                "  (select count(*) from fact.pg_activity_snapshot" +
                "    where instance_pk = ? and snapshot_ts > now() - interval '10 minutes'" +
                "      and xact_start is not null" +
                "      and snapshot_ts - xact_start > interval '10 minutes'" +
                "      and state is distinct from 'idle'" +
                "      and backend_type is distinct from 'autovacuum worker') +" +
                "  (select count(*) from fact.pg_replication_slot_snapshot" +
                "    where instance_pk = ? and sample_ts > now() - interval '30 minutes'" +
                "      and active = false)",
                Integer.class, instancePk, instancePk);
            return count != null && count > 0;
        } catch (Exception e) {
            log.debug("hasXminHorizonRisk kontrolu hatasi instance={}: {}", instancePk, e.getMessage());
            return false;
        }
    }

    /** Teshis 2/2b gozlem penceresi — worker'lar araliklı calistigi icin 2 saat. */
    private static final String WORKER_EVIDENCE_WINDOW = "2 hours";

    /** Oran yorumlamak icin gereken minimum farkli toplama ani sayisi. */
    private static final int MIN_DISTINCT_SNAPSHOTS = 10;

    /** Tazelik esigi: cadence * 2 + bu pay (saat kaymasi/toplama suresi icin). */
    private static final int FRESHNESS_GRACE_SECONDS = 600;

    /** VacuumDelay wait_event'inin eklendigi PG surumu. */
    private static final int VACUUM_DELAY_MIN_PG_MAJOR = 13;

    /** autovacuum_worker_slots'un eklendigi PG surumu. */
    private static final int WORKER_SLOTS_MIN_PG_MAJOR = 18;

    /**
     * Autovacuum worker gozlem kanitini toplar — Teshis 2 (IO bekleme orani)
     * ve Teshis 2b (throttle uykusu orani), artı 1b-ii senaryosunun ihtiyac
     * duydugu guncel worker sayisi/kapasitesi.
     *
     * Tasarim kararlari (docs/autovacuum-cost-diagnosis-design.md):
     * - runningWorkers, instance'in EN GUNCEL GENEL snapshot'indaki distinct
     *   pid sayisidir. Sadece worker satirlarinin en son snapshot'ina bakmak
     *   yanlis olurdu: o cycle'da hic worker yoksa sorgu eski bir zamana
     *   denk gelir ve "su an 0 worker var" yerine "worker'in en son
     *   goruldugu anda kac worker vardi" sorusunu cevaplar.
     * - Yeterlilik kapisi count(distinct snapshot_ts) >= 10; ham satir sayisi
     *   DEGIL (ayni worker art arda cycle'larda gorunup tek olayi fazla
     *   sayabilir).
     * - Tazelik esigi sabit degil, cluster cycle cadence * 2 + grace.
     * - Uc adlandirilmis kova + residual = totalSamples (tanimi geregi).
     */
    AutovacuumWorkerEvidence fetchAutovacuumWorkerStatus(long instancePk) {
        try {
            Integer pgMajor = fetchPgMajor(instancePk);
            int cadenceSeconds = fetchClusterCadenceSeconds(instancePk);
            int freshnessSeconds = cadenceSeconds * 2 + FRESHNESS_GRACE_SECONDS;

            Map<String, Object> agg = jdbc.queryForMap(
                "with latest as (" +
                "  select max(snapshot_ts) as ts from fact.pg_activity_snapshot" +
                "  where instance_pk = ? and snapshot_ts > now() - interval '" + WORKER_EVIDENCE_WINDOW + "'" +
                "), window_rows as (" +
                "  select wait_event, wait_event_type, snapshot_ts" +
                "  from fact.pg_activity_snapshot" +
                "  where instance_pk = ? and backend_type = 'autovacuum worker'" +
                "    and snapshot_ts > now() - interval '" + WORKER_EVIDENCE_WINDOW + "'" +
                ") select" +
                "  (select ts from latest) as latest_ts," +
                "  (select ts from latest) > now() - make_interval(secs => ?) as latest_is_fresh," +
                "  (select count(distinct pid) from fact.pg_activity_snapshot" +
                "     where instance_pk = ? and backend_type = 'autovacuum worker'" +
                "       and snapshot_ts = (select ts from latest)) as running_workers," +
                "  count(*) as total_samples," +
                "  count(distinct snapshot_ts) as distinct_snapshots," +
                "  count(*) filter (where wait_event_type = 'IO') as io_wait_samples," +
                "  count(*) filter (where wait_event = 'VacuumDelay') as throttle_sleep_samples," +
                "  count(*) filter (where wait_event is null) as no_wait_event_samples" +
                " from window_rows",
                instancePk, instancePk, freshnessSeconds, instancePk);

            long totalSamples = toLong(agg.get("total_samples"), 0L);
            int distinctSnapshots = (int) toLong(agg.get("distinct_snapshots"), 0L);
            long ioWaitSamples = toLong(agg.get("io_wait_samples"), 0L);
            long rawThrottleSamples = toLong(agg.get("throttle_sleep_samples"), 0L);
            long noWaitEventSamples = toLong(agg.get("no_wait_event_samples"), 0L);
            boolean latestIsFresh = Boolean.TRUE.equals(agg.get("latest_is_fresh"));
            Integer runningWorkers = agg.get("running_workers") instanceof Number n ? n.intValue() : null;

            // Residual: uc adlandirilmis kova disinda kalan wait'ler (Lock,
            // BufferPin, LWLock, Client...). Kovalar ortusmedigi icin negatif
            // olmamali; yine de savunmaci olarak 0'a kirpiyoruz.
            long otherWaitSamples = Math.max(0L,
                totalSamples - ioWaitSamples - rawThrottleSamples - noWaitEventSamples);

            boolean sufficientSamples = distinctSnapshots >= MIN_DISTINCT_SNAPSHOTS;
            boolean versionKnown = pgMajor != null;

            EvidenceStatus currentWorkerStatus = !latestIsFresh
                ? EvidenceStatus.NO_FRESH_SNAPSHOT
                : EvidenceStatus.AVAILABLE;

            EvidenceStatus ioWaitStatus;
            if (totalSamples == 0) {
                ioWaitStatus = EvidenceStatus.NO_FRESH_SNAPSHOT;
            } else if (!sufficientSamples) {
                ioWaitStatus = EvidenceStatus.INSUFFICIENT_DATA;
            } else {
                ioWaitStatus = EvidenceStatus.AVAILABLE;
            }

            // VacuumDelay PG13'te eklendi — oncesinde sinyal HIC YOK. Sessizce
            // 0 gostermek "throttle yok" gibi yanlis bir sonuca goturur.
            EvidenceStatus throttleStatus;
            Long throttleSleepSamples;
            if (!versionKnown) {
                throttleStatus = EvidenceStatus.UNKNOWN_VERSION;
                throttleSleepSamples = null;
            } else if (pgMajor < VACUUM_DELAY_MIN_PG_MAJOR) {
                throttleStatus = EvidenceStatus.UNSUPPORTED_VERSION;
                throttleSleepSamples = null;
            } else if (totalSamples == 0) {
                throttleStatus = EvidenceStatus.NO_FRESH_SNAPSHOT;
                throttleSleepSamples = rawThrottleSamples;
            } else if (!sufficientSamples) {
                throttleStatus = EvidenceStatus.INSUFFICIENT_DATA;
                throttleSleepSamples = rawThrottleSamples;
            } else {
                throttleStatus = EvidenceStatus.AVAILABLE;
                throttleSleepSamples = rawThrottleSamples;
            }

            Integer maxWorkers = readIntSetting(instancePk, "autovacuum_max_workers");
            Integer workerSlots = versionKnown && pgMajor >= WORKER_SLOTS_MIN_PG_MAJOR
                ? readIntSetting(instancePk, "autovacuum_worker_slots") : null;

            // PG18: autovacuum_max_workers, worker_slots'tan buyuk ayarlanirsa
            // etkisiz kalir — gercek kapasite ikisinin kucugu.
            Integer effectiveWorkerCapacity;
            EvidenceStatus capacityStatus;
            if (!versionKnown) {
                effectiveWorkerCapacity = maxWorkers;
                capacityStatus = EvidenceStatus.UNKNOWN_VERSION;
            } else if (pgMajor < WORKER_SLOTS_MIN_PG_MAJOR) {
                effectiveWorkerCapacity = maxWorkers;
                capacityStatus = maxWorkers == null
                    ? EvidenceStatus.UNKNOWN : EvidenceStatus.NOT_APPLICABLE;
            } else if (maxWorkers == null || workerSlots == null) {
                effectiveWorkerCapacity = null;
                capacityStatus = EvidenceStatus.UNKNOWN;
            } else {
                effectiveWorkerCapacity = Math.min(maxWorkers, workerSlots);
                capacityStatus = EvidenceStatus.AVAILABLE;
            }

            return new AutovacuumWorkerEvidence(
                runningWorkers, maxWorkers, workerSlots, effectiveWorkerCapacity,
                totalSamples, distinctSnapshots, ioWaitSamples, throttleSleepSamples,
                noWaitEventSamples, otherWaitSamples,
                currentWorkerStatus, ioWaitStatus, throttleStatus, capacityStatus);

        } catch (Exception e) {
            log.debug("fetchAutovacuumWorkerStatus okunamadi instance={}: {}", instancePk, e.getMessage());
            return AutovacuumWorkerEvidence.unknown();
        }
    }

    /** instance_capability.pg_major — bilinmiyorsa null. */
    private Integer fetchPgMajor(long instancePk) {
        try {
            List<Integer> rows = jdbc.queryForList(
                "select pg_major from control.instance_capability where instance_pk = ?",
                Integer.class, instancePk);
            return rows.isEmpty() ? null : rows.get(0);
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Instance'in cluster toplama araligi (saniye) — tazelik esigi bunun
     * uzerinden hesaplanir, sabit bir sayi kullanilmaz.
     */
    private int fetchClusterCadenceSeconds(long instancePk) {
        try {
            List<Integer> rows = jdbc.queryForList(
                "select sp.cluster_interval_seconds from control.instance_inventory ii " +
                "join control.schedule_profile sp on sp.schedule_profile_id = ii.schedule_profile_id " +
                "where ii.instance_pk = ?",
                Integer.class, instancePk);
            return rows.isEmpty() || rows.get(0) == null ? 60 : rows.get(0);
        } catch (Exception e) {
            return 60;
        }
    }

    /** En guncel setting degerini int olarak okur; yoksa/parse edilemezse null. */
    private Integer readIntSetting(long instancePk, String settingName) {
        try {
            List<String> rows = jdbc.queryForList(
                "select setting_value from fact.pg_settings_snapshot " +
                "where instance_pk = ? and setting_name = ? " +
                "order by snapshot_ts desc limit 1",
                String.class, instancePk, settingName);
            return rows.isEmpty() ? null : Integer.parseInt(rows.get(0).trim());
        } catch (Exception e) {
            return null;
        }
    }

    private static long toLong(Object value, long fallback) {
        return value instanceof Number n ? n.longValue() : fallback;
    }

    /**
     * Etkin cost ayari — cozumleme zinciri her parametre icin BAGIMSIZ isler:
     *   1. Tablo override (control.table_relopts_snapshot) >= 0  -> zincir biter
     *      -1 veya yok -> adim 2
     *   2. Global autovacuum_* >= 0 -> zincir biter; -1 -> adim 3
     *   3. Global vacuum_* -> etkin deger
     * Herhangi bir adimda eksik/bozuk/bayat deger -> UNKNOWN (null), ve
     * cagiran taraf aksiyon ONERMEZ (bilinmeyen deger "yuksek" sayilamaz).
     *
     * Not: Tablo-ozel cost override'i olan tablolari isleyen worker'lar PG'nin
     * cost balancing algoritmasinin DISINDA kalir (PG18 routine-vacuuming
     * dok.) — bu yuzden worker basina butce aritmetigi yapilmaz, sadece
     * gozlemlenen oranlar raporlanir.
     *
     * @return etkin cost_delay (ms) veya cozumlenemezse null
     */
    Integer resolveEffectiveCostDelay(long instancePk, Long relid) {
        try {
            // Adim 1: tablo override — V095 ile ayristirilmis kolondan okunuyor
            // (toplama aninda bir kez parse edilir, her sorguda tekrar degil).
            if (relid != null) {
                List<Integer> tableRows = jdbc.queryForList(
                    "select autovacuum_vacuum_cost_delay from control.table_relopts_snapshot " +
                    "where instance_pk = ? and relid = ?",
                    Integer.class, instancePk, relid);
                if (!tableRows.isEmpty() && tableRows.get(0) != null && tableRows.get(0) >= 0) {
                    return tableRows.get(0);
                }
                // override yok (null) veya -1 sentinel -> global'e dus
            }
            // Adim 2: global autovacuum_vacuum_cost_delay
            Integer avDelay = readIntSetting(instancePk, "autovacuum_vacuum_cost_delay");
            if (avDelay == null) {
                return null; // eksik/bozuk -> UNKNOWN
            }
            if (avDelay >= 0) {
                return avDelay;
            }
            // Adim 3: -1 sentinel -> genel vacuum_cost_delay (PG11+ davranisi,
            // hicbir surumde kaldirilmadi)
            return readIntSetting(instancePk, "vacuum_cost_delay");
        } catch (Exception e) {
            log.debug("resolveEffectiveCostDelay okunamadi instance={}: {}", instancePk, e.getMessage());
            return null;
        }
    }

    /** pg_stat_io view'inin eklendigi PG surumu (Teshis 0'in on kosulu). */
    private static final int PG_STAT_IO_MIN_PG_MAJOR = 16;

    /** Teshis 0 gozlem penceresi. */
    private static final String IO_IMPACT_WINDOW = "24 hours";

    /**
     * Teshis 0'in durum modeli — SIRALI degerlendirilir, ilk eslesen kazanir.
     * "Veri yok" ile "gercekten sifir" ayni gostergeye indirgenmemeli:
     * birincisi olcumun yoklugu, ikincisi bir olcum sonucudur.
     */
    enum IoImpactStatus {
        /** instance_capability satiri yok/pg_major null — desteklenip desteklenmedigi bilinmiyor. */
        UNKNOWN_CAPABILITY,
        /** pg_major < 16 veya has_pg_stat_io=false — bu surumde pg_stat_io yok. */
        UNSUPPORTED,
        /** is_reachable=false — veri guncel olmayabilir, guncelmis gibi sunma. */
        INSTANCE_UNREACHABLE,
        /** Pencerede hic fact satiri yok VEYA en son satir tazelik esiginin disinda. */
        NO_FRESH_DATA,
        /** Taze satir var ama autovacuum worker icin relation I/O toplami 0. */
        ZERO_IO_WITH_FRESH_DATA,
        /** Sayilar mevcut ve yorumlanabilir. */
        AVAILABLE
    }

    /**
     * Teshis 0 sonucu — autovacuum worker'in kendi ISLEM SAYISI (byte/IOPS
     * DEGIL, pg_stat_io'nun saydigi sayfa islemi sayisi).
     *
     * @param autovacuumReads       worker'in relation okuma islemi sayisi
     * @param clientReads           client backend'in ayni penceredeki sayisi
     * @param readsRatio            autovacuum/client orani; client 0 ise null
     *                              (sonsuz oran uretmemek icin)
     * @param metricCoveragePct     sayaci NOT NULL olan satirlarin yuzdesi;
     *                              100'den kucukse kismi olcum var demektir
     */
    record AutovacuumIoImpact(
        Long autovacuumReads,
        Long autovacuumWrites,
        Long clientReads,
        Long clientWrites,
        Double readsRatio,
        double metricCoveragePct,
        IoImpactStatus status
    ) {
        static AutovacuumIoImpact of(IoImpactStatus status) {
            return new AutovacuumIoImpact(null, null, null, null, null, 0.0, status);
        }
    }

    /**
     * Teshis 0: autovacuum worker'larin dogrudan I/O ISLEM SAYISI (PG16+).
     *
     * BONUS kanit — birincil degil. Kayitli instance'larin cogunlugu PG16'nin
     * altinda oldugu icin bu teshis filonun buyuk kisminda calismaz; birincil
     * kanit Teshis 2/2b'dir (wait-event tabanli, surum bagimsiz).
     *
     * Onemli kapsam sinirlari (mesaj metninde de korunmali):
     * - reads/writes BYTE veya disk IOPS DEGIL, sayfa islemi sayisidir.
     * - Sadece worker'in KENDI islemidir; checkpointer'in ayni kirli
     *   sayfalari sonradan diske yazmasi ayri bir backend_type satirinda
     *   gorunur, worker'a atfedilmez.
     * - object='relation' filtresi zorunlu (temp relation vb. karismasin).
     * - Sifir I/O "autovacuum calismadi" DEMEK DEGIL — worker calisip tum
     *   sayfalari shared buffers'ta bulmus (hit) olabilir.
     */
    AutovacuumIoImpact fetchAutovacuumIoImpact(long instancePk) {
        try {
            List<Map<String, Object>> capRows = jdbc.queryForList(
                "select pg_major, has_pg_stat_io, is_reachable " +
                "from control.instance_capability where instance_pk = ?",
                instancePk);
            if (capRows.isEmpty() || capRows.get(0).get("pg_major") == null) {
                return AutovacuumIoImpact.of(IoImpactStatus.UNKNOWN_CAPABILITY);
            }
            Map<String, Object> cap = capRows.get(0);
            int pgMajor = ((Number) cap.get("pg_major")).intValue();
            if (pgMajor < PG_STAT_IO_MIN_PG_MAJOR || Boolean.FALSE.equals(cap.get("has_pg_stat_io"))) {
                return AutovacuumIoImpact.of(IoImpactStatus.UNSUPPORTED);
            }
            if (Boolean.FALSE.equals(cap.get("is_reachable"))) {
                return AutovacuumIoImpact.of(IoImpactStatus.INSTANCE_UNREACHABLE);
            }

            int freshnessSeconds = fetchClusterCadenceSeconds(instancePk) * 2 + FRESHNESS_GRACE_SECONDS;
            Map<String, Object> row = jdbc.queryForMap(
                "select" +
                "  count(*) as source_row_count," +
                "  count(*) filter (where reads_delta is not null) as reads_valid_count," +
                "  max(sample_ts) > now() - make_interval(secs => ?) as is_fresh," +
                "  sum(reads_delta) filter (where backend_type = 'autovacuum worker') as av_reads," +
                "  sum(writes_delta) filter (where backend_type = 'autovacuum worker') as av_writes," +
                "  sum(reads_delta) filter (where backend_type = 'client backend') as client_reads," +
                "  sum(writes_delta) filter (where backend_type = 'client backend') as client_writes" +
                " from fact.pg_io_stat_delta" +
                " where instance_pk = ? and object = 'relation'" +
                "   and sample_ts > now() - interval '" + IO_IMPACT_WINDOW + "'",
                freshnessSeconds, instancePk);

            long sourceRowCount = toLong(row.get("source_row_count"), 0L);
            // NO_FRESH_DATA karari SATIR SAYISINA dayanir, sayac degerine degil —
            // sayac 0 gelmesi bir olcumdur, satir olmamasi olcumun yokluğudur.
            if (sourceRowCount == 0 || !Boolean.TRUE.equals(row.get("is_fresh"))) {
                return AutovacuumIoImpact.of(IoImpactStatus.NO_FRESH_DATA);
            }

            long readsValidCount = toLong(row.get("reads_valid_count"), 0L);
            double coveragePct = 100.0 * readsValidCount / sourceRowCount;

            Long avReads = row.get("av_reads") instanceof Number n ? n.longValue() : 0L;
            Long avWrites = row.get("av_writes") instanceof Number n ? n.longValue() : 0L;
            Long clientReads = row.get("client_reads") instanceof Number n ? n.longValue() : 0L;
            Long clientWrites = row.get("client_writes") instanceof Number n ? n.longValue() : 0L;

            if (avReads == 0L && avWrites == 0L) {
                return new AutovacuumIoImpact(avReads, avWrites, clientReads, clientWrites,
                    null, coveragePct, IoImpactStatus.ZERO_IO_WITH_FRESH_DATA);
            }

            // Client okuma 0 ise oran uretme — sonsuz/anlamsiz deger yerine
            // mutlak sayilar raporlanir.
            Double ratio = clientReads > 0 ? (double) avReads / clientReads : null;

            return new AutovacuumIoImpact(avReads, avWrites, clientReads, clientWrites,
                ratio, coveragePct, IoImpactStatus.AVAILABLE);

        } catch (Exception e) {
            log.debug("fetchAutovacuumIoImpact okunamadi instance={}: {}", instancePk, e.getMessage());
            return AutovacuumIoImpact.of(IoImpactStatus.UNKNOWN_CAPABILITY);
        }
    }

    /**
     * Teshis 0'i gozlemsel bir cumleye cevirir. "I/O maliyeti"/"MB" gibi
     * hacim iddialari kurulmaz — sadece islem sayisi raporlanir.
     */
    String renderIoImpactEvidence(AutovacuumIoImpact io) {
        return switch (io.status()) {
            case AVAILABLE -> io.readsRatio() != null
                ? String.format(
                    " Son 24 saatte autovacuum worker'lar %,d okuma / %,d yazma işlemi yaptı (client backend'in %.1f katı okuma).%s",
                    io.autovacuumReads(), io.autovacuumWrites(), io.readsRatio(),
                    io.metricCoveragePct() < 100.0
                        ? String.format(" (Ölçüm kapsamı %%%.0f — bazı örneklerde sayaç okunamadı.)", io.metricCoveragePct())
                        : "")
                : String.format(
                    " Son 24 saatte autovacuum worker'lar %,d okuma / %,d yazma işlemi yaptı; client backend bu pencerede hiç okuma yapmadığı için oran hesaplanmadı.",
                    io.autovacuumReads(), io.autovacuumWrites());
            case ZERO_IO_WITH_FRESH_DATA ->
                " Son 24 saatte autovacuum worker'lar için sayılan relation okuma/yazma işlemi yok — bu, autovacuum'un hiç çalışmadığı anlamına gelmez (sayfaların tümü shared buffers'ta bulunmuş olabilir).";
            case NO_FRESH_DATA ->
                " I/O işlem sayısı kanıtı için bu pencerede taze veri yok (collector yeni başlamış veya bir toplama döngüsü atlanmış olabilir).";
            case UNSUPPORTED ->
                " (I/O işlem sayısı kanıtı bu PG sürümünde yok — pg_stat_io PG16'da eklendi.)";
            case INSTANCE_UNREACHABLE ->
                " (Instance şu an erişilemez durumda; I/O kanıtı güncel olmayabilir, bu yüzden gösterilmedi.)";
            case UNKNOWN_CAPABILITY ->
                " (Instance'ın PG sürümü henüz bilinmediği için I/O işlem sayısı kanıtı değerlendirilemedi.)";
        };
    }

    /**
     * Sürüm varsayilani: PG11'de 20ms, PG12'den itibaren 2ms (PG12 release
     * notes). "cost_delay dusur" onerisi SADECE etkin deger bu varsayilandan
     * BUYUK ise uretilir — "non-default" yeterli degil, cunku 0ms/1ms de
     * non-default ama varsayilandan dusuk.
     */
    static int versionDefaultCostDelayMs(Integer pgMajor) {
        return pgMajor != null && pgMajor < 12 ? 20 : 2;
    }

    /**
     * "cost_delay dusur" onerisi UC kosul birden saglanirsa uretilir:
     *   1. Throttle uykusu orani yuksek (>%50), VE
     *   2. Yeterli orneklem var (throttleStatus == AVAILABLE), VE
     *   3. Etkin cost_delay surum varsayilanindan BUYUK.
     * Aksi halde eşik/worker ayarina yonlendiren notr bir aksiyon doner.
     * Ayar cozumlenemezse (UNKNOWN) oneri bastirilir — bilinmeyen bir deger
     * "yuksek" sayilamaz.
     */
    private String buildCostDelayAction(long instancePk, Long relid, AutovacuumWorkerEvidence ev) {
        Integer pgMajor = fetchPgMajor(instancePk);
        Integer effectiveDelay = resolveEffectiveCostDelay(instancePk, relid);
        int versionDefault = versionDefaultCostDelayMs(pgMajor);

        boolean throttleEvidenceUsable = ev.throttleStatus() == EvidenceStatus.AVAILABLE;
        boolean throttleHigh = throttleEvidenceUsable && ev.throttleSleepPct() > 50.0;
        boolean delayAboveDefault = effectiveDelay != null && effectiveDelay > versionDefault;

        if (throttleHigh && delayAboveDefault) {
            return String.format(
                "Etkin autovacuum_vacuum_cost_delay = %dms, bu PG sürümünün varsayılanından (%dms) yüksek ve worker örneklemelerin çoğunda throttle uykusunda gözlemlendi — cost_delay'i düşürmeyi (veya autovacuum_vacuum_cost_limit'i artırmayı) değerlendir; ardından ölü satır trendini birkaç döngü izle.",
                effectiveDelay, versionDefault);
        }
        if (effectiveDelay == null) {
            return "Etkin cost ayarı okunamadı (fact.pg_settings_snapshot'ta değer yok veya bayat) — cost_delay için bir öneri üretilmedi. autovacuum_vacuum_scale_factor/threshold ayarlarını ve autovacuum_max_workers'ı gözden geçir; pg_stat_progress_vacuum ile çalışan vacuum'un ilerleyişini izle.";
        }
        return String.format(
            "Etkin autovacuum_vacuum_cost_delay = %dms (sürüm varsayılanı %dms) — throttle ayarı bu tablo için darboğaz görünmüyor, bu yüzden cost_delay değişikliği önerilmiyor. Bunun yerine autovacuum_vacuum_scale_factor/threshold ayarlarını (tetikleme sıklığı) ve autovacuum_max_workers'ı gözden geçir; pg_stat_progress_vacuum ile çalışan vacuum'un ilerleyişini izle.",
            effectiveDelay, versionDefault);
    }

    /**
     * Worker wait-event dagilimini GOZLEMSEL bir cumleye cevirir (Teshis 2/2b).
     * Dil bilincli olarak nedensel degil:
     * - "I/O tamamlanmasi bekleniyordu" denir, "disk yavas" DENMEZ —
     *   PostgreSQL bu ayrimi yapmaz (OS cache'i de olabilir).
     * - "throttle uykusunda gozlemlendi" denir, "throttling yavaslatiyor"
     *   DENMEZ — VacuumDelay cost butcesine ULASILDIGI icin olusur, yani
     *   worker'in calistigini gosterir, bir ariza gostergesi degildir.
     * Yetersiz/desteklenmeyen kanit sessizce 0 olarak sunulmaz.
     *
     * @return bos string (kanit yoksa) veya " " ile baslayan ek cumle(ler)
     */
    String renderWorkerWaitEvidence(AutovacuumWorkerEvidence ev) {
        StringBuilder sb = new StringBuilder();

        if (ev.ioWaitStatus() == EvidenceStatus.AVAILABLE
                || ev.throttleStatus() == EvidenceStatus.AVAILABLE) {
            sb.append(String.format(
                " Ek gözlem: son 2 saatte autovacuum worker'ları %d farklı toplama anında örneklendi",
                ev.distinctSnapshots()));
            if (ev.ioWaitStatus() == EvidenceStatus.AVAILABLE) {
                sb.append(String.format(
                    "; örneklemelerin %%%.0f'inde bir I/O işleminin tamamlanması bekleniyordu",
                    ev.ioWaitPct()));
            }
            if (ev.throttleStatus() == EvidenceStatus.AVAILABLE) {
                sb.append(String.format(
                    "; %%%.0f'inde cost-based throttle uykusundaydı (VacuumDelay)",
                    ev.throttleSleepPct()));
            }
            if (ev.otherWaitSamples() > 0) {
                sb.append(String.format(
                    "; %d örnekte ise başka bir bekleme türü (Lock/BufferPin vb.) görüldü",
                    ev.otherWaitSamples()));
            }
            sb.append(".");
        } else if (ev.ioWaitStatus() == EvidenceStatus.INSUFFICIENT_DATA) {
            sb.append(String.format(
                " Worker wait-event dağılımı için yeterli örneklem yok (son 2 saatte yalnız %d farklı toplama anı; yorum için en az %d gerekiyor).",
                ev.distinctSnapshots(), MIN_DISTINCT_SNAPSHOTS));
        } else if (ev.ioWaitStatus() == EvidenceStatus.NO_FRESH_SNAPSHOT) {
            sb.append(" Son 2 saatte hiç autovacuum worker örneklenmedi — bu, worker'ın hiç çalışmadığı anlamına gelmez, örnekleme anlarına denk gelmemiş de olabilir.");
        }

        if (ev.throttleStatus() == EvidenceStatus.UNSUPPORTED_VERSION) {
            sb.append(" (Throttle uykusu kanıtı bu PG sürümünde yok — VacuumDelay wait_event'i PG13'te eklendi.)");
        }

        return sb.toString();
    }

    /**
     * dead_tuple_ratio icin kanita dayali teshis+aksiyon metni uretir (karar
     * agaci: docs/bloat-diagnosis-decision-tree.md, PGSTAT-P0-036 AC6).
     * Kaynaklar: postgresql.org vacuum docs, Citus/pganalyze muhendislik
     * bloglari (xmin horizon, autovacuum throttling). Sira onemli — ilk
     * eslesen senaryo kullanilir.
     *
     * @return [teshis, aksiyon] — ikisi de bos olmayan Turkce metin.
     */
    /**
     * JdbcTemplate.queryForList() ile okunan bir timestamptz kolonunu
     * OffsetDateTime'a normalize eder.
     *
     * NEDEN GEREKLI (canli testte kesfedilen bug, 2026-08-26): Spring'in
     * ColumnMapRowMapper'i rs.getObject(i) cagirir; PostgreSQL JDBC surucusu
     * timestamptz icin varsayilan olarak java.sql.Timestamp doner,
     * OffsetDateTime DEGIL. diagnoseBloat() ise "lastAutovacuum instanceof
     * OffsetDateTime" kaliplarini kullaniyordu — java.sql.Timestamp bu testi
     * HIC gecmez, dolayisiyla senaryo 3.5, 4 ve 4.5 hicbir kosulda
     * tetiklenemiyordu (sessiz, gorunmez bir bug: alert hep senaryo 5'e
     * dusuyordu). rs.getObject(col, OffsetDateTime.class) kullanan
     * ResultSet-tabanli kod yollari bu sorundan etkilenmez; sorun sadece
     * queryForList() yolunda.
     *
     * @return normalize edilmis deger; tip taninmiyorsa/null ise null
     */
    static java.time.OffsetDateTime asOffsetDateTime(Object value) {
        if (value instanceof java.time.OffsetDateTime odt) {
            return odt;
        }
        if (value instanceof java.sql.Timestamp ts) {
            return ts.toInstant().atOffset(
                java.time.ZoneId.systemDefault().getRules().getOffset(ts.toInstant()));
        }
        if (value instanceof java.time.Instant inst) {
            return inst.atOffset(
                java.time.ZoneId.systemDefault().getRules().getOffset(inst));
        }
        if (value instanceof java.time.LocalDateTime ldt) {
            return ldt.atZone(java.time.ZoneId.systemDefault()).toOffsetDateTime();
        }
        return null;
    }

    /**
     * Aksiyon metinlerinde kullanilacak, kopyalanip calistirilabilir tam tablo
     * adi ("sema"."tablo"). Kimlik ancak kucuk harf/rakam/alt cizgi iceriyorsa
     * ve rakamla baslamiyorsa tirnaksiz birakilir; aksi halde cift tirnak
     * icine alinir (PG kimlik kurallari). Ad okunamazsa eski yer tutucuya
     * duser — bozuk bir komut uretmektense yer tutucu daha guvenli.
     */
    static String qualifiedTableName(Map<String, Object> record) {
        Object schema = record.get("schemaname");
        Object table = record.get("relname");
        if (!(schema instanceof String s) || !(table instanceof String t)
                || s.isBlank() || t.isBlank()) {
            return "<şema.tablo>";
        }
        return quoteIdentIfNeeded(s) + "." + quoteIdentIfNeeded(t);
    }

    private static final java.util.regex.Pattern SAFE_IDENT =
        java.util.regex.Pattern.compile("[a-z_][a-z0-9_]*");

    private static String quoteIdentIfNeeded(String ident) {
        if (SAFE_IDENT.matcher(ident).matches()) {
            return ident;
        }
        // Ic tirnaklari PG kuralina gore ikile
        return "\"" + ident.replace("\"", "\"\"") + "\"";
    }

    /**
     * diagnoseBloat() sonucu. suppressAlert=true ise cagiran taraf alert
     * ACMAZ — durum gecici kabul edilir ve sadece israr sayaci ilerletilir.
     */
    record BloatDiagnosis(String diagnosis, String action, boolean suppressAlert) {
        static BloatDiagnosis of(String diagnosis, String action) {
            return new BloatDiagnosis(diagnosis, action, false);
        }
        static BloatDiagnosis suppressed() {
            return new BloatDiagnosis("", "", true);
        }
    }

    /** Senaryo 4'un alert'e donusmesi icin gereken ust uste gorulme sayisi. */
    private static final int SCENARIO_4_STREAK_THRESHOLD = 3;

    /**
     * Ozet bildirimde en fazla kac kayit listelenir. Kalanlar "… ve N kayit
     * daha" olarak GORUNUR — sessizce kirpilmaz, cunku o durumda mesaj her seyi
     * kapsiyormus gibi okunur.
     */
    private static final int BATCH_NOTIFICATION_LIST_LIMIT = 5;

    /**
     * Bir degerlendirmede bir instance icin en fazla kac kayit alert acabilir.
     *
     * Bu ayni zamanda alert sayisinin ust siniridir: kayit basina bir alert
     * acildigi icin (PGSTAT-P0-039), yeni eklenen ve onlarca tablosu birden
     * bozuk olan bir instance sinirsiz alert uretememelidir.
     *
     * Sorgular bilerek LIMIT+1 satir ceker: donen satir sayisi limiti asiyorsa
     * kirpma OLDUGU anlasilir ve loglanir. Sessiz kirpma, "her sey kapsandi"
     * gibi okunur — oysa kapsanmamistir.
     */
    private static final int PER_RECORD_QUERY_LIMIT = 10;

    /**
     * Israr sayacini bir artirir ve guncel degeri doner (V096).
     *
     * Sayac KALICI bir tabloda tutulur, in-memory degil: collector her
     * deploy'da yeniden baslar ve in-memory bir sayac her restart'ta
     * sifirlanirdi — israrli bir sorun bu yuzden hicbir zaman esige
     * ulasamazdi (PGSTAT-P1-009'da belgelenen ayni tuzak).
     *
     * Trend kontrolu: olu satir sayisi bir onceki degerlendirmeden BUYUK
     * degilse streak ilerletilmez (1'e resetlenir). Boylece "artiyor" degil
     * "sabit kalmis" bir durum, sirf tekrar gorulduğu icin alert'e
     * donusmez.
     *
     * @return guncellenmis streak degeri; okuma/yazma hatasinda esik degeri
     *         (guvenli taraf: sayac calismiyorsa alert'i bastirma)
     */
    private int bumpScenarioStreak(Map<String, Object> record, long instancePk,
                                    String scenario, Long currentDeadTup) {
        Long dbid = record.get("dbid") instanceof Number n ? n.longValue() : null;
        Long relid = record.get("relid") instanceof Number n ? n.longValue() : null;
        if (dbid == null || relid == null) {
            // Kimlik yoksa sayac tutulamaz — bastirma, alert'i ac.
            return SCENARIO_4_STREAK_THRESHOLD;
        }
        try {
            // Sayac, senaryonun ust uste kac degerlendirmedir SURDUGUNU sayar —
            // olu satirin artmaya devam edip etmedigini degil.
            //
            // Onceki hali "olu satir bir onceki olcumden buyukse ilerle, degilse
            // 1'e resetle" idi. Bu, dibe vurup orada duran tablolari kalici olarak
            // gorunmez yapiyordu: uretimde security.user (6 canli / 3224 olu, hic
            // vacuum edilmemis) her degerlendirmede ayni olu satir sayisini
            // gosterdigi icin sayac hep 1'e donuyor ve esik hicbir zaman
            // asilmiyordu (2026-08-27). Oysa hic vacuum edilmemis bir tablo,
            // artmayi biraksa da duzeltilmesi gereken bir durumdur.
            //
            // Gecici birikimler yine bastirilir, ama farkli bir mekanizmayla:
            // autovacuum tabloyu temizleyince kayit esigi asmayi birakir ya da
            // baska bir senaryoya gecer, her iki durumda da clearScenarioStreak()
            // satiri siler. Yani "kendi kendine duzelen" durum sayaci hic
            // doldurmaya firsat bulamaz.
            //
            // Sayac yalnizca olu satir GERILEDIGINDE sifirlanir: bu, kismi bir
            // vacuum'un ise yaradigi anlamina gelir, israr sayilmaz.
            jdbc.update("""
                insert into control.bloat_scenario_streak
                  (instance_pk, dbid, relid, scenario, streak_count,
                   first_seen_at, last_seen_at, last_dead_tup)
                values (?, ?, ?, ?, 1, now(), now(), ?)
                on conflict (instance_pk, dbid, relid, scenario) do update set
                  streak_count = case
                    when excluded.last_dead_tup is not null
                      and control.bloat_scenario_streak.last_dead_tup is not null
                      and excluded.last_dead_tup < control.bloat_scenario_streak.last_dead_tup
                    then 1
                    else control.bloat_scenario_streak.streak_count + 1
                  end,
                  first_seen_at = case
                    when excluded.last_dead_tup is not null
                      and control.bloat_scenario_streak.last_dead_tup is not null
                      and excluded.last_dead_tup < control.bloat_scenario_streak.last_dead_tup
                    then now()
                    else control.bloat_scenario_streak.first_seen_at
                  end,
                  last_seen_at = now(),
                  last_dead_tup = excluded.last_dead_tup
                """,
                instancePk, dbid, relid, scenario, currentDeadTup);

            Integer streak = jdbc.queryForObject(
                "select streak_count from control.bloat_scenario_streak " +
                "where instance_pk = ? and dbid = ? and relid = ? and scenario = ?",
                Integer.class, instancePk, dbid, relid, scenario);
            return streak != null ? streak : SCENARIO_4_STREAK_THRESHOLD;
        } catch (Exception e) {
            log.debug("bloat streak sayaci guncellenemedi instance={} relid={}: {}",
                instancePk, relid, e.getMessage());
            // Sayac calismiyorsa alert'i bastirma — kacirmak, fazladan
            // uyarmaktan daha zararli.
            return SCENARIO_4_STREAK_THRESHOLD;
        }
    }

    /**
     * Sayac ilerlemeli mi, yoksa sifirlanmali mi?
     *
     * Yukaridaki SQL'deki case ifadesinin bire bir karsiligi — SQL'i test
     * edemedigimiz icin karar kurali burada da duruyor ve testler bunu
     * dogruluyor. Ikisi degisirse birlikte degismeli.
     *
     * Kural: sayac her gorulmede ilerler; yalnizca olu satir GERILEDIGINDE
     * sifirlanir (kismi vacuum ise yaramis demektir, israr sayilmaz).
     * Olu satirin sabit kalmasi israrin bittigi anlamina gelmez.
     *
     * @return true ise sayac 1'e sifirlanir, false ise +1 ilerler
     */
    static boolean shouldResetStreak(Long previousDeadTup, Long currentDeadTup) {
        if (previousDeadTup == null || currentDeadTup == null) return false;
        return currentDeadTup < previousDeadTup;
    }

    /** Senaryo artik gecerli degilse sayaci temizler. */
    private void clearScenarioStreak(Map<String, Object> record, long instancePk, String scenario) {
        Long dbid = record.get("dbid") instanceof Number n ? n.longValue() : null;
        Long relid = record.get("relid") instanceof Number n ? n.longValue() : null;
        if (dbid == null || relid == null) return;
        try {
            jdbc.update("delete from control.bloat_scenario_streak " +
                "where instance_pk = ? and dbid = ? and relid = ? and scenario = ?",
                instancePk, dbid, relid, scenario);
        } catch (Exception e) {
            log.debug("bloat streak sayaci temizlenemedi instance={}: {}", instancePk, e.getMessage());
        }
    }

    /** Mesajda gosterilecek trend ozeti: "1.2M -> 1.5M" gibi. */
    private static String formatStreakTrend(Map<String, Object> record) {
        Object prev = record.get("prev_dead_tup");
        Object curr = record.get("dead_tup");
        if (prev instanceof Number p && curr instanceof Number c) {
            return String.format("%,d → %,d ölü satır", p.longValue(), c.longValue());
        }
        return "ölü satır sayısı artıyor";
    }

    /** Israrın ne zaman baslamis oldugunu okur; okunamazsa jenerik metin. */
    private String formatStreakFirstSeen(Map<String, Object> record, long instancePk, String scenario) {
        Long dbid = record.get("dbid") instanceof Number n ? n.longValue() : null;
        Long relid = record.get("relid") instanceof Number n ? n.longValue() : null;
        if (dbid == null || relid == null) return "bilinmiyor";
        try {
            List<Map<String, Object>> rows = jdbc.queryForList(
                "select first_seen_at from control.bloat_scenario_streak " +
                "where instance_pk = ? and dbid = ? and relid = ? and scenario = ?",
                instancePk, dbid, relid, scenario);
            if (rows.isEmpty()) return "bilinmiyor";
            java.time.OffsetDateTime firstSeen = asOffsetDateTime(rows.get(0).get("first_seen_at"));
            if (firstSeen == null) return "bilinmiyor";
            long minutes = java.time.Duration.between(
                firstSeen, java.time.OffsetDateTime.now()).toMinutes();
            return minutes < 60
                ? String.format("%d dakika önce", minutes)
                : String.format("%d saat önce", minutes / 60);
        } catch (Exception e) {
            return "bilinmiyor";
        }
    }

    /**
     * Bu tablonun canli/olu satir tahminlerine guvenilebilir mi?
     *
     * n_live_tup ve n_dead_tup istatistiktir, olcum degil. PostgreSQL bunlari
     * sadece ANALYZE veya VACUUM sirasinda gercek sayimla duzeltir; ikisi de hic
     * calismamissa degerler insert/delete sayaclarindan turetilir ve
     * pg_stat_database.stats_reset sonrasi keyfi bicimde yanlis olabilir —
     * cunku sayaclar sifirlanirken tablodaki mevcut satirlar sayilmaz.
     *
     * Uretimde olculen (2026-08-27, instance 2 / etsrooms): security.user
     * n_live_tup=6 ve n_dead_tup=3224 bildiriyordu, yani %99.81 olu oran ve
     * kritik alert. select count(*) ise 26257 dondu — gercek oran ~%11, uyari
     * esiginin bile altinda. last_analyze ve last_autoanalyze ikisi de NULL'di,
     * stats_reset 176 gun oncesineydi. Ayni sekilde t_supplier_rez 62 canli
     * satir sanilirken gercekte 4.593.352 satir tutuyordu. Bes tablo icin bes
     * yanlis alert uretildi.
     *
     * Uretilen teshis metni celiskiyi kendisi yaziyordu — "esik (50 = 50 + 0.20
     * x 0 canli satir) coktan asilmis (1233280 olu satir)" — sifir canli satirli
     * bir tabloda 1.2M olu satir fiziksel olarak imkansiz, ama hicbir kontrol
     * bunu durdurmuyordu.
     *
     * Neden sadece "analiz edilmis mi" sorusu: olu satir tarafina da
     * guvenilemez. Ayni olcumde t_supplier_rez ANALYZE oncesi 907, sonrasi
     * 11879 olu satir gosterdi — iki sayac da ayni sifirlamadan besleniyor.
     * Tek saglam ayrim, degerlerin duzeltilmis olup olmadigi.
     *
     * Bilincli olarak canli satir sayisina BAKMIYOR: gercekten az canli + cok
     * olu satirli tablolar vardir (kuyruk/staging tablolari) ve onlar
     * istatistikleri guncel oldugu surece alert uretmeye devam etmeli.
     */
    static boolean statsUntrustworthy(Map<String, Object> record) {
        return record.get("last_analyze") == null
            && record.get("last_autoanalyze") == null
            && record.get("last_vacuum") == null
            && record.get("last_autovacuum") == null;
    }

    private BloatDiagnosis diagnoseBloat(Map<String, Object> record, long instancePk) {
        // Istatistik guvenilirlik kapisi — karar agacindan ONCE. Buradan sonraki
        // her senaryo n_live_tup/n_dead_tup uzerinden oran ve tetikleme esigi
        // hesapliyor; degerler duzeltilmemisse o aritmetigin tamami anlamsiz.
        if (statsUntrustworthy(record)) {
            Long dead = record.get("dead_tup") instanceof Number n ? n.longValue() : null;
            Long live = record.get("live_tup") instanceof Number n ? n.longValue() : null;
            String name = qualifiedTableName(record);
            return BloatDiagnosis.of(
                String.format(
                    "Bu tablonun istatistikleri GÜVENİLMEZ — hiç ANALYZE ve hiç VACUUM"
                    + " görmemiş. PostgreSQL canlı/ölü satır sayılarını yalnızca bu iki"
                    + " işlem sırasında gerçek sayımla düzeltir; öncesinde değerler"
                    + " insert/delete sayaçlarından tahmin edilir ve istatistik sıfırlaması"
                    + " sonrası gerçekle ilişkisi kalmayabilir. Bu yüzden bildirilen oran"
                    + " (%s canlı / %s ölü satır) gerçek durumu yansıtmıyor olabilir —"
                    + " tabloda göründüğünden çok daha fazla canlı satır bulunabilir.",
                    live != null ? String.format("%,d", live) : "?",
                    dead != null ? String.format("%,d", dead) : "?"),
                String.format(
                    "Önce ANALYZE %s; çalıştır, sonra bu alarmı yeniden değerlendir."
                    + " İstatistikler düzeldikten sonra tablo gerçekten eşiğin üstündeyse"
                    + " alarm doğru teşhisle yeniden açılır; değilse kendiliğinden kapanır.",
                    name));
        }

        // timestamptz kolonlari queryForList()'ten java.sql.Timestamp olarak
        // gelir — normalize etmeden instanceof OffsetDateTime kontrolleri
        // her zaman false doner (bkz. asOffsetDateTime javadoc'u).
        java.time.OffsetDateTime lastAutovacuumTs = asOffsetDateTime(record.get("last_autovacuum"));
        Object lastAutovacuum = record.get("last_autovacuum");
        Object lastVacuum = record.get("last_vacuum");
        boolean vacuumIneffective = Boolean.TRUE.equals(record.get("vacuum_ineffective"));
        Long autovacuumCountSum = record.get("autovacuum_count_sum") instanceof Number n ? n.longValue() : 0L;
        Object prevDeadTupObj = record.get("prev_dead_tup");
        Long currentDeadTup = record.get("dead_tup") instanceof Number n ? n.longValue() : null;
        Long liveTup = record.get("live_tup") instanceof Number n ? n.longValue() : null;
        // Aksiyon metinlerinde <sema.tablo> yer tutucusu yerine GERCEK adi
        // kullaniyoruz — kullanici komutu dogrudan kopyalayip calistirabilsin
        // (musteri talebi 2026-08-27).
        String qualifiedName = qualifiedTableName(record);

        // Senaryo 1: hic vacuum edilmemis (otomatik veya manuel). "Kontrol et"
        // demek yerine elimizdeki gercek veriyle (fact.pg_settings_snapshot,
        // canli/olu satir) KESIN teshis yapiyoruz — musteri talebi 2026-08-24:
        // "biz de tum veriler var, neden olabilir kontrol et diyorsun".
        if (lastAutovacuum != null || lastVacuum != null) {
            // Tablo artik vacuum edilmis — senaryo 1b-ii israri sona erdi,
            // sayaci temizle ki gelecekte sifirdan baslasin.
            clearScenarioStreak(record, instancePk, "scenario_1b_ii");
        }

        if (lastAutovacuum == null && lastVacuum == null) {
            Object[] settings = fetchAutovacuumSettings(instancePk);
            Boolean autovacuumOn = (Boolean) settings[0];
            BigDecimal scaleFactor = (BigDecimal) settings[1];
            Long avThreshold = (Long) settings[2];

            if (Boolean.FALSE.equals(autovacuumOn)) {
                return BloatDiagnosis.of(
                    "Bu tablo hiç vacuum edilmemiş — instance genelinde autovacuum kapalı (autovacuum=off)." ,
                    String.format("postgresql.conf'ta autovacuum=on yap ve reload et; ardından VACUUM ANALYZE %s; ile mevcut bloat'u hemen temizle.", qualifiedName)
                );
            }
            if (scaleFactor != null && avThreshold != null && liveTup != null) {
                long triggerThreshold = avThreshold + scaleFactor.multiply(BigDecimal.valueOf(liveTup)).longValue();
                if (currentDeadTup != null && currentDeadTup >= triggerThreshold) {
                    // "Olabilir" degil KESIN sonuc — pg_class.reloptions artik
                    // toplaniyor (V093), gercek override durumunu direkt soyluyoruz.
                    Boolean tableAutovacuumOverride = fetchTableAutovacuumOverride(
                        instancePk, (String) record.get("schemaname"), (String) record.get("relname"));
                    if (Boolean.FALSE.equals(tableAutovacuumOverride)) {
                        return BloatDiagnosis.of(
                            String.format("Bu tablo hiç vacuum edilmemiş. Autovacuum genel olarak açık (autovacuum=on) ve tetikleme eşiği (%d = %d + %.2f × %d canlı satır) çoktan aşılmış (%d ölü satır) — ama bu TABLOYA ÖZEL autovacuum_enabled=false override'ı var (pg_class.reloptions), bu yüzden hiç çalışmadı.",
                                triggerThreshold, avThreshold, scaleFactor, liveTup, currentDeadTup),
                            String.format("ALTER TABLE %s RESET (autovacuum_enabled); ile bu tabloya özel override'ı kaldır, ardından VACUUM ANALYZE %s; çalıştır.",
                                qualifiedName, qualifiedName)
                        );
                    }
                    // 1b-ii: "olasi nedenler" degil KESIN sonuc — su an calisan
                    // worker sayisini/limitini de okuyup net soyluyoruz (musteri
                    // talebi 2026-08-24: "bu net teshis degil").
                    AutovacuumWorkerEvidence workerStatus = fetchAutovacuumWorkerStatus(instancePk);
                    Integer runningWorkers = workerStatus.runningWorkers();
                    // Kapasite karsilastirmasinda PG18'in autovacuum_worker_slots
                    // sinirini da dikkate alan etkin degeri kullaniyoruz — sadece
                    // max_workers'a bakmak PG18'de yaniltici olabilir.
                    Integer maxWorkers = workerStatus.effectiveWorkerCapacity();
                    boolean workerStatusUsable = runningWorkers != null && maxWorkers != null
                        && workerStatus.currentWorkerStatus() == EvidenceStatus.AVAILABLE;
                    if (workerStatusUsable && runningWorkers >= maxWorkers) {
                        return BloatDiagnosis.of(
                            String.format("Bu tablo hiç vacuum edilmemiş. Autovacuum açık (autovacuum=on, tablo düzeyinde override yok) ama tetikleme eşiği (%d = %d + %.2f × %d canlı satır) çoktan aşılmış (%d ölü satır) — şu an %d/%d autovacuum worker çalışıyor, TÜM WORKER'LAR DOLU, bu yüzden bu tablo sıraya girip beklemiş.",
                                triggerThreshold, avThreshold, scaleFactor, liveTup, currentDeadTup, runningWorkers, maxWorkers),
                            String.format("autovacuum_max_workers ayarını artır (postgresql.conf, reload gerektirir) veya diğer tabloların vacuum yükünü azalt; bu tabloyu şimdi VACUUM ANALYZE %s; ile öne al.", qualifiedName)
                        );
                    }
                    if (workerStatusUsable) {
                        // Esik asilmis, worker doygunlugu YOK, ama autovacuum
                        // yine de tetiklenmemis. Ilk goruslerde bu gercekten
                        // "naptime dongusunu bekliyor" olabilir — o yuzden
                        // alert acmiyoruz, israr sayacini ilerletiyoruz.
                        // Israr ederse "birazdan calisacak" demek yanlis olur:
                        // eski kod bunu 6 gun boyunca soyluyordu (musteri
                        // gozlemi 2026-08-27, instance 14).
                        int waitStreak = bumpScenarioStreak(record, instancePk,
                            "scenario_1b_ii", currentDeadTup);
                        if (waitStreak < SCENARIO_4_STREAK_THRESHOLD) {
                            return BloatDiagnosis.suppressed();
                        }
                        return BloatDiagnosis.of(
                            String.format("Bu tablo hiç vacuum edilmemiş ve bu durum ISRAR EDİYOR: üst üste %d değerlendirmedir tetikleme eşiği (%d = %d + %.2f × %d canlı satır) aşılmış (%d ölü satır) ve worker doygunluğu da yok (%d/%d çalışıyor, boş kapasite var) — yani autovacuum'un bu tabloyu almasını engelleyen şey naptime beklemesi DEĞİL. İlk fark edilme: %s.",
                                waitStreak, triggerThreshold, avThreshold, scaleFactor, liveTup,
                                currentDeadTup, runningWorkers, maxWorkers,
                                formatStreakFirstSeen(record, instancePk, "scenario_1b_ii")),
                            String.format("Bu tablonun autovacuum'a hiç alınmama nedenini araştır: autovacuum launcher çalışıyor mu, bu database autovacuum'dan dışlanmış mı, tabloda ANALYZE hiç çalışmamış olabilir mi (n_live_tup=%d güvenilir mi). Geçici çözüm: VACUUM ANALYZE %s; çalıştır.",
                                liveTup, qualifiedName)
                        );
                    }
                    return BloatDiagnosis.of(
                        String.format("Bu tablo hiç vacuum edilmemiş. Autovacuum açık (autovacuum=on, tablo düzeyinde override yok) ama tetikleme eşiği (%d = %d + %.2f × %d canlı satır) çoktan aşılmış (%d ölü satır) — worker durumu okunamadı (fact.pg_activity_snapshot/pg_settings_snapshot henüz toplanmamış olabilir).",
                            triggerThreshold, avThreshold, scaleFactor, liveTup, currentDeadTup),
                        String.format("VACUUM ANALYZE %s; çalıştır; bir toplama döngüsü sonrası bu alert tekrar tetiklenirse worker durumu netleşecek.", qualifiedName)
                    );
                }
                // Senaryo 1c: autovacuum'un KENDI tetikleme esigi henuz asilmamis.
                // Burada yapilacak bir sey yok — PostgreSQL bu tabloyu vacuum
                // etmeye deger bulmuyor ve esik asilinca kendisi alacak. Alert
                // acmak, operatore "sorun yok" deyip yine de uyarmak olur.
                //
                // Eski hali iki sekilde yanlisti (musteri geri bildirimi
                // 2026-08-28: "cok sacma alertler"):
                //  1) Teshis "henuz gerekmiyor olabilir" derken alert aciyordu —
                //     kendi kendisiyle celisiyordu.
                //  2) Aksiyon metni kaydin "Bacak B (mutlak dead-tuple esigi) ile
                //     yakalandigini" IDDIA ediyordu, kontrol etmeden. Uretimde
                //     drr_test_suite_entries 61 canli / 46 olu satirla geldi: 46,
                //     Bacak B esiginin (500) cok altinda, yani kayit Bacak A'dan
                //     (oran + min satir) gecmisti. Metin olgusal olarak yanlisti.
                //
                // Bastirma, kaydi tamamen gorunmez yapmaz: gercekten sorunlu
                // tablolar esik asildiginda bir ustteki dallara duser ve orada
                // kanita dayali teshisle alert uretirler.
                return BloatDiagnosis.suppressed();
            }
            return BloatDiagnosis.of(
                "Bu tablo hiç vacuum edilmemiş (otomatik veya manuel); global autovacuum ayarları henüz toplanmamış (fact.pg_settings_snapshot boş veya gece toplaması yapılmamış), kesin eşik hesabı yapılamadı.",
                String.format("VACUUM ANALYZE %s; çalıştır; bir gece toplaması geçtikten sonra bu alert tekrar tetiklenirse eşik hesabı otomatik olarak netleşecek.", qualifiedName)
            );
        }

        // Senaryo 2: autovacuum calisiyor ama xmin horizon engelliyor
        if (autovacuumCountSum > 0 && hasXminHorizonRisk(instancePk)) {
            return BloatDiagnosis.of(
                "Autovacuum çalışıyor ama uzun süren bir transaction/kullanılmayan replication slot ölü satırların temizlenmesini engelliyor (xmin horizon).",
                "pg_stat_activity'de xact_start'ı eski olan bağlantıları ve pg_replication_slots'ta aktif olmayan slot'ları kontrol et; gerekirse sonlandır/sil."
            );
        }

        // Senaryo 3: autovacuum sik calisiyor ama yetersiz (Bacak C sinyali).
        // Kanit katmani (PGSTAT-P1-011): "muhtemelen I/O throttling" gibi bir
        // tahmin yerine gozlemlenen wait dagilimini ve etkin cost ayarini
        // ekliyoruz — boylece "cost_delay dusur" onerisinin gecerli olup
        // olmadigi elle sorgu yazmadan gorulebiliyor.
        if (vacuumIneffective) {
            AutovacuumWorkerEvidence ev = fetchAutovacuumWorkerStatus(instancePk);
            Long relid = record.get("relid") instanceof Number rn ? rn.longValue() : null;
            return BloatDiagnosis.of(
                "Autovacuum çalışıyor ama ölü satırları yeterince hızlı temizleyemiyor."
                    + renderWorkerWaitEvidence(ev)
                    + renderIoImpactEvidence(fetchAutovacuumIoImpact(instancePk)),
                buildCostDelayAction(instancePk, relid, ev)
            );
        }

        // Senaryo 3.5: son vacuum ESKI (>24 saat) ve bloat artmaya devam ediyor
        // — "hic vacuum edilmemis" degil ama "bir suredir calismiyor" (musteri
        // talebi 2026-08-24: "bir suredir calismiyor bloat surekli artiyor gibi
        // yorum yapacak mi?"). Senaryo 1'den (last_autovacuum/last_vacuum NULL)
        // farkli — burada EN AZ BIR KEZ calismis ama son calismadan sonra
        // durmus ve artis surmus. Ayni worker/xmin kanitlarini kullanarak
        // "neden calismiyor" sorusuna da kesin cevap veriyoruz.
        boolean staleAutovacuum = lastAutovacuumTs != null
            && lastAutovacuumTs.isBefore(java.time.OffsetDateTime.now().minusHours(24));
        boolean increasingTrendEarly = prevDeadTupObj instanceof Number prevN2 && currentDeadTup != null
            && currentDeadTup > prevN2.longValue();
        if (staleAutovacuum && increasingTrendEarly) {
            long hoursSinceLastAutovacuum = java.time.Duration.between(
                lastAutovacuumTs, java.time.OffsetDateTime.now()).toHours();
            AutovacuumWorkerEvidence workerStatus = fetchAutovacuumWorkerStatus(instancePk);
            Integer runningWorkers = workerStatus.runningWorkers();
            Integer maxWorkers = workerStatus.effectiveWorkerCapacity();
            if (runningWorkers != null && maxWorkers != null
                    && workerStatus.currentWorkerStatus() == EvidenceStatus.AVAILABLE
                    && runningWorkers >= maxWorkers) {
                return BloatDiagnosis.of(
                    String.format("Son autovacuum %d saat önce çalışmış, o zamandan beri bir daha çalışmadı ve ölü satır sayısı artmaya devam ediyor — şu an %d/%d worker çalışıyor, TÜM WORKER'LAR DOLU, bu yüzden bu tablo sıraya girip beklemiş.%s",
                        hoursSinceLastAutovacuum, runningWorkers, maxWorkers,
                        renderWorkerWaitEvidence(workerStatus)),
                    String.format("autovacuum_max_workers ayarını artır veya diğer tabloların vacuum yükünü azalt; bu tabloyu şimdi VACUUM ANALYZE %s; ile öne al.", qualifiedName)
                );
            }
            return BloatDiagnosis.of(
                String.format("Son autovacuum %d saat önce çalışmış, o zamandan beri bir daha çalışmadı ve ölü satır sayısı artmaya devam ediyor — worker doygunluğu yok, bu yüzden neden tekrar tetiklenmediği ayrıca araştırılmalı (olası nedenler: bu süre içinde tetikleme eşiği hâlâ aşılmamış olabilir, ya da autovacuum_naptime uzun ayarlanmış olabilir).",
                    hoursSinceLastAutovacuum),
                String.format("postgresql.conf'ta autovacuum_naptime ayarını kontrol et; sürekli artış devam ediyorsa VACUUM ANALYZE %s; ile hemen temizle.", qualifiedName)
            );
        }

        // Senaryo 4: yeni olusmus/artan trend, autovacuum henuz yetismemis olabilir
        boolean recentAutovacuum = lastAutovacuumTs != null
            && lastAutovacuumTs.isAfter(java.time.OffsetDateTime.now().minusHours(24));
        boolean increasingTrend = prevDeadTupObj instanceof Number prevN && currentDeadTup != null
            && currentDeadTup > prevN.longValue();

        // Senaryo 4.5: autovacuum KRONIK olarak calisiyor (bu pencerede birden
        // fazla kez, autovacuum_count_sum > 1) ve son calismasi yakin zamanda
        // olmasina ragmen trend hala artiyor — bu "henuz yetismedi, biraz
        // bekle" degil (senaryo 4'un varsayimi), "esik bu tablonun gercek
        // guncelleme hizina gore YANLIS KALIBRE EDILMIS" demek. Musteri talebi
        // 2026-08-25: pgstat kendi DB'sinde (agg.pg_table_stat_hourly, 5dk'da
        // bir UPSERT'lenen bir rollup tablosu) tam bu senaryoyu yasadi ama
        // sistem bunu hic tespit edip onermedi — kullanici manuel arastirmayla
        // buldu. Bu senaryo, ayni durumu bir daha otomatik yakalamak icin.
        if (recentAutovacuum && increasingTrend && autovacuumCountSum > 1) {
            AutovacuumWorkerEvidence ev45 = fetchAutovacuumWorkerStatus(instancePk);
            return BloatDiagnosis.of(
                String.format("Autovacuum kronik olarak çalışıyor (bu pencerede %d kez) ve son çalışması yakın zamanda oldu, ama ölü satır sayısı hâlâ artmaya devam ediyor — bu, tablonun güncelleme hızına göre autovacuum tetikleme eşiğinin (autovacuum_vacuum_scale_factor/threshold) çok yüksek kaldığını gösterir.%s%s",
                    autovacuumCountSum, renderWorkerWaitEvidence(ev45),
                    renderIoImpactEvidence(fetchAutovacuumIoImpact(instancePk))),
                String.format("Bu tablo için ALTER TABLE %s SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 5000); gibi daha düşük bir eşik ayarla (özellikle sık UPSERT/UPDATE alan büyük tablolarda varsayılan %%20 oranı çok geç tetiklenir).",
                    qualifiedName)
            );
        }

        // Senaryo 4: autovacuum yakin zamanda calismis ve trend artiyor ama
        // yukaridaki daha kesin senaryolarin HICBIRINE takilmamis. Bu, cogu
        // zaman toplama anina denk gelmis GECICI bir olu satir birikimidir —
        // autovacuum zaten calisiyor, bir-iki dongude temizleyecek.
        //
        // Bu yuzden ilk goruslerde alert ACMIYORUZ, sadece israr sayacini
        // ilerletiyoruz. Ust uste SCENARIO_4_STREAK_THRESHOLD kez ayni tabloda
        // ayni durumu gorursek (ve olu satir sayisi her seferinde artmaya devam
        // ediyorsa) artik "gecici" degil "gercekten yetisemiyor" kabul edip
        // alert aciyoruz (musteri talebi 2026-08-27).
        if (recentAutovacuum && increasingTrend) {
            int streak = bumpScenarioStreak(record, instancePk, "scenario_4", currentDeadTup);
            if (streak < SCENARIO_4_STREAK_THRESHOLD) {
                return BloatDiagnosis.suppressed();
            }
            return BloatDiagnosis.of(
                String.format("Autovacuum çalışıyor ama yetişemiyor: ölü satır sayısı üst üste %d değerlendirmede artmaya devam etti (%s). İlk fark edilme: %s. Bu artık geçici bir birikim değil — autovacuum döngüsü bu tablonun güncelleme hızına yetişemiyor.",
                    streak, formatStreakTrend(record), formatStreakFirstSeen(record, instancePk, "scenario_4")),
                String.format("Önce VACUUM ANALYZE %s; ile mevcut birikimi temizle; ardından bu tablo için autovacuum_vacuum_scale_factor/threshold değerlerini düşürerek autovacuum'un daha sık tetiklenmesini sağla.",
                    qualifiedName)
            );
        }
        // Trend artmiyorsa veya autovacuum yakin zamanda calismadiysa senaryo 4
        // gecerli degil — varsa eski sayaci temizle ki gelecekte sifirdan
        // baslasin (kesintili artislar birikip yanlis alert uretmesin).
        clearScenarioStreak(record, instancePk, "scenario_4");

        // Senaryo 5: varsayilan
        return BloatDiagnosis.of(
            "Autovacuum ayarları veya iş yükü tabloyu dengede tutmaya yetmiyor.",
            String.format("VACUUM ANALYZE %s; çalıştır; sürekli tekrarlıyorsa autovacuum_vacuum_scale_factor'ü düşürmeyi değerlendir.", qualifiedName)
        );
    }

    private static String sanitizeOperator(String op) {
        if (op == null) return ">";
        return switch (op) {
            case ">", "<", ">=", "<=", "=" -> op;
            default -> ">";
        };
    }

    /**
     * Template render basarisiz oldugunda kullanilan fallback mesaja
     * teshis/aksiyon metnini ekler. Bu olmadan, template bulunamadigi her
     * durumda diagnoseBloat()'un urettigi kanit (worker wait dagilimi, etkin
     * cost ayari, senaryo teshisi) sessizce kaybolur ve kullanici jenerik
     * "Tablo esigi asti" satirindan baska bir sey gormez.
     *
     * @param baseMessage jenerik esik mesaji
     * @param ctx         template context'i — "diagnosis"/"bloat_action" tasir
     */
    static String appendDiagnosisToFallback(String baseMessage, Map<String, Object> ctx) {
        Object diagnosis = ctx.get("diagnosis");
        Object action = ctx.get("bloat_action");
        StringBuilder sb = new StringBuilder(baseMessage);
        if (diagnosis instanceof String s && !s.isBlank()) {
            sb.append("\n").append(s.trim());
        }
        if (action instanceof String s && !s.isBlank()) {
            sb.append("\nÖnerilen aksiyon: ").append(s.trim());
        }
        return sb.toString();
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
            log.warn("flatline desteklenmiyor rule={} metric={}.{}", ruleId, metricType, metricName);
            return;
        }
        String[] parts = tableSql.split("\\|");
        String table = parts[0], col = parts[1], timeCol = parts[2];

        List<Map<String, Object>> targets = loadTargetInstances(rule);
        log.info("Flatline rule={} flatlineMinutes={} targets={}", ruleId, flatlineMinutes, targets.size());
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
                log.info("Flatline check rule={} instance={} cnt={} mx={} mn={}",
                    ruleId, instancePk, cnt, stats.get("mx"), stats.get("mn"));
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
                    resolveAlert(alertKey, rule, instancePk);
                    updateLastEval(ruleId, instancePk, mx, null);
                } else {
                    updateLastEval(ruleId, instancePk, mx != null ? mx : BigDecimal.ZERO, null);
                }
            } catch (Exception e) {
                log.warn("Flatline sorgu hatasi rule_id={} instance={}: {}", ruleId, instancePk, e.getMessage(), e);
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
                resolveAlert(alertKey, rule, instancePk);
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
            case "database_metric.autovacuum_count"      -> "fact.pg_table_stat_delta|autovacuum_count_delta|sample_ts";
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
                   sensitivity, cooldown_minutes, auto_resolve,
                   -- dead_tuple_ratio'nun uc bacakli override'lari. Bunlar
                   -- SELECT listesinde eksikti: kolonlar migration'la eklenmis
                   -- ve kod bunlari okuyacak sekilde yazilmisti, ama sorguya
                   -- eklenmedigi icin rule.get(...) her zaman null donuyor ve
                   -- kod sessizce kod-ici varsayilanlara dusuyordu. Sonuc:
                   -- kullanici UI'dan bu esikleri degistirse bile hicbir etkisi
                   -- olmuyordu (canli test, 2026-08-26).
                   bloat_min_rows, bloat_abs_dead_tup, bloat_vacuum_ineffective_count
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
    /** toLong'un aksine null'i 0'a degil null'a cevirir — "kullanici override etmedi" ile "0" ayrimi icin. */
    private Long toLongOrNull(Object v) { return v instanceof Number n ? n.longValue() : null; }
    private Integer toIntOrNull(Object v) { return v instanceof Number n ? n.intValue() : null; }
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
