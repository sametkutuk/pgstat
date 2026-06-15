package com.pgstat.collector.service;

import com.pgstat.collector.model.InstanceInfo;
import com.pgstat.collector.repository.InventoryRepository;
import com.pgstat.collector.repository.ReportConfigRepository;
import com.pgstat.collector.repository.ReportHistoryRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.time.DayOfWeek;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Gunluk ve haftalik rapor uretici.
 * Bildirim kanallarina (email/telegram/teams) gonderilir.
 *
 * Gunluk rapor: UTC 06:00 (TR 09:00) — is gunu basinda
 * Haftalik rapor: Pazartesi UTC 06:00 — hafta ozeti
 */
@Service
public class ReportGenerator {

    private static final Logger log = LoggerFactory.getLogger(ReportGenerator.class);

    private final JdbcTemplate jdbc;
    private final InventoryRepository inventoryRepo;
    private final NotificationService notificationService;
    private final ReportConfigRepository reportConfigRepo;
    private final ReportHistoryRepository reportHistoryRepo;
    private static final DateTimeFormatter REPORT_RANGE_FMT =
        DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss 'UTC'");

    public ReportGenerator(JdbcTemplate jdbc, InventoryRepository inventoryRepo,
                           NotificationService notificationService,
                           ReportConfigRepository reportConfigRepo,
                           ReportHistoryRepository reportHistoryRepo) {
        this.jdbc = jdbc;
        this.inventoryRepo = inventoryRepo;
        this.notificationService = notificationService;
        this.reportConfigRepo = reportConfigRepo;
        this.reportHistoryRepo = reportHistoryRepo;
    }

    // Config cache — her 60 saniyede DB'den yenilenir. JobOrchestrator her 5s'de
    // dailyHourUtc/weeklyHourUtc cagiriyordu, her biri ayri DB query ataniyordu.
    // 60s TTL ile gunde 17k query yerine ~1.4k query → marjinal iyilestirme,
    // UI'dan config degisikligi en fazla 60s'de yansir (kabul edilebilir gecikme).
    private volatile java.util.Map<String, Object> cachedConfig = ReportConfigRepository.defaults();
    private volatile long lastConfigLoadMs = 0;
    private static final long CONFIG_CACHE_TTL_MS = 60_000;

    private synchronized java.util.Map<String, Object> config() {
        long now = System.currentTimeMillis();
        if (now - lastConfigLoadMs > CONFIG_CACHE_TTL_MS) {
            try {
                cachedConfig = reportConfigRepo.get();
            } catch (Exception e) {
                log.debug("Config reload hatasi, eski cache kullaniliyor: {}", e.getMessage());
            }
            lastConfigLoadMs = now;
        }
        return cachedConfig;
    }

    /** Config'e gore: bu rapor tipi enabled mi? */
    public boolean isDailyEnabled() {
        Object v = config().get("daily_enabled");
        return v == null || Boolean.TRUE.equals(v);
    }

    public boolean isWeeklyEnabled() {
        Object v = config().get("weekly_enabled");
        return v == null || Boolean.TRUE.equals(v);
    }

    /** Hangi UTC saatte gunluk rapor gonderilmeli (config'den). */
    public int dailyHourUtc() {
        Object v = config().get("daily_hour_utc");
        return v instanceof Number ? ((Number) v).intValue() : 6;
    }

    public int weeklyHourUtc() {
        Object v = config().get("weekly_hour_utc");
        return v instanceof Number ? ((Number) v).intValue() : 6;
    }

    /**
     * DB-bazlı tek günlük gönderim guard'ı. UTC bugün için aynı tipte
     * 'sent' veya 'partial' status'lu kayıt varsa true. Restart'a karşı korur.
     */
    private boolean alreadySentToday(String reportType) {
        try {
            Integer count = jdbc.queryForObject(
                "select count(*) from ops.report_history " +
                "where report_type = ? " +
                "  and generated_at >= date_trunc('day', now() at time zone 'UTC') " +
                "  and sent_status in ('sent', 'partial')",
                Integer.class, reportType);
            return count != null && count > 0;
        } catch (Exception e) {
            // Tablo yoksa veya hata: konservatif, gönderime izin ver
            log.debug("alreadySentToday hata, gönderim devam: {}", e.getMessage());
            return false;
        }
    }

    /** Rapor gonderim sonucu — DB history kaydi icin. */
    private record SendResult(int channelsCount, String recipientsJson,
                               String status, String errorMessage) {}

    // =========================================================================
    // Gunluk Ozet Rapor
    // =========================================================================

    /**
     * Gunluk ozet rapor uretir ve bildirim kanallarina gonderir.
     * Her instance icin: TPS, baglanti, WAL, cache, temp, deadlock ozeti.
     */
    /** Zamanlanmis gunluk rapor: idempotency guard aktif (gunde bir kez). */
    public void generateAndSendDailyReport() {
        generateAndSendDailyReport(false);
    }

    /**
     * Gunluk ozet rapor uretir ve bildirim kanallarina gonderir.
     * Her instance icin: TPS, baglanti, WAL, cache, temp, deadlock ozeti.
     *
     * @param force true ise bugun zaten gonderilmis olsa bile yeniden uretir
     *              (manuel/elle tetikleme). false ise gunluk idempotency guard'i uygular.
     * @return olusturulan report_history id'si, gonderim atlandiysa 0
     */
    public long generateAndSendDailyReport(boolean force) {
        if (!isDailyEnabled()) {
            log.info("Gunluk rapor devre disi (config), atlandi");
            return 0;
        }
        // DB-bazlı idempotency: bugün zaten gönderilmişse atla (force degilse).
        // In-memory flag collector restart'ta sıfırlanıyordu → restart UTC 06:00-06:59
        // arasındaysa rapor 2. kez gönderiliyordu. Bu kontrol restart'a karşı korur.
        if (!force && alreadySentToday("daily")) {
            log.info("Gunluk rapor bugun zaten gonderilmis (DB), atlandi");
            return 0;
        }
        log.info("Gunluk rapor uretiliyor{}...", force ? " (manuel/force)" : "");
        String title = "pgstat Gunluk Ozet - " + LocalDate.now(ZoneOffset.UTC);
        try {
            String body = buildDailyReport();
            if (body == null || body.isBlank()) {
                log.warn("Gunluk rapor bos uretildi, gonderim atlandi");
                return 0;
            }
            SendResult result = sendReportToChannels(title, body);
            String eventsBody = buildDailyEventReport();
            if (eventsBody != null && !eventsBody.isBlank()) {
                sendReportToChannels("pgstat Gunluk Olaylar - " + LocalDate.now(ZoneOffset.UTC), eventsBody);
            }
            String historyBody = eventsBody == null || eventsBody.isBlank()
                ? body
                : body + "\n\n---\n\n" + eventsBody;
            // History kaydi (basari/kismi/hata fark etmeksizin)
            long reportId = 0;
            try {
                reportId = reportHistoryRepo.insert("daily", title, historyBody,
                    result.recipientsJson(), result.status(),
                    result.channelsCount(), result.errorMessage());
            } catch (Exception e) {
                log.warn("Rapor history kaydi yazilamadi: {}", e.getMessage());
            }
            log.info("Gunluk rapor gonderildi (status={}, channels={})",
                result.status(), result.channelsCount());
            return reportId;
        } catch (Exception e) {
            log.warn("Gunluk rapor hatasi: {}", e.getMessage());
            return 0;
        }
    }

    private String buildDailyReport() {
        StringBuilder sb = new StringBuilder();
        String today = LocalDate.now(ZoneOffset.UTC).toString();
        sb.append("pgstat Gunluk Ozet - ").append(today).append("\n\n");

        // Fleet durumu
        try {
            Map<String, Object> fleet = jdbc.queryForMap("""
                select
                  count(*) filter (where is_active) as total,
                  count(*) filter (where is_active and bootstrap_state = 'ready') as ready,
                  count(*) filter (where is_active and bootstrap_state = 'degraded') as degraded
                from control.instance_inventory
                """);
            int openAlerts = jdbc.queryForObject(
                "select count(*) from ops.alert where status = 'open'", Integer.class);

            sb.append("Fleet: ").append(fleet.get("total")).append(" instance (")
              .append(fleet.get("ready")).append(" ready, ")
              .append(fleet.get("degraded")).append(" degraded) | ")
              .append(openAlerts).append(" acik alert\n\n");
        } catch (Exception e) {
            sb.append("Fleet bilgisi alinamadi\n\n");
        }

        // Per-instance ozet
        sb.append("Per-instance (son 24h):\n");
        try {
            List<Map<String, Object>> instances = jdbc.queryForList("""
                select i.instance_pk, i.display_name,
                  coalesce((select round(sum(xact_commit_delta + xact_rollback_delta)::numeric / 86400)
                    from fact.pg_database_delta d
                    where d.instance_pk = i.instance_pk and d.sample_ts > now() - interval '24 hours'), 0) as avg_tps,
                  coalesce((select sum(numbackends) from fact.pg_database_delta d
                    where d.instance_pk = i.instance_pk
                    and d.sample_ts = (select max(sample_ts) from fact.pg_database_delta where instance_pk = i.instance_pk)), 0) as connections,
                  coalesce((select sum(period_wal_size_byte) from fact.pg_wal_snapshot w
                    where w.instance_pk = i.instance_pk and w.sample_ts > now() - interval '24 hours'), 0) as wal_bytes,
                  coalesce((select round(100.0 * sum(blks_hit_delta)::numeric / nullif(sum(blks_hit_delta + blks_read_delta), 0), 1)
                    from fact.pg_database_delta d
                    where d.instance_pk = i.instance_pk and d.sample_ts > now() - interval '24 hours'), 0) as cache_pct,
                  coalesce((select sum(temp_files_delta) from fact.pg_database_delta d
                    where d.instance_pk = i.instance_pk and d.sample_ts > now() - interval '24 hours'), 0) as temp_files,
                  coalesce((select sum(temp_bytes_delta) from fact.pg_database_delta d
                    where d.instance_pk = i.instance_pk and d.sample_ts > now() - interval '24 hours'), 0) as temp_bytes,
                  coalesce((select sum(deadlocks_delta) from fact.pg_database_delta d
                    where d.instance_pk = i.instance_pk and d.sample_ts > now() - interval '24 hours'), 0) as deadlocks,
                  coalesce((select count(*) from (
                    select distinct on (x.dbid, x.index_relid) x.is_valid, x.is_ready
                    from fact.pg_index_stat_delta x
                    where x.instance_pk = i.instance_pk
                    order by x.dbid, x.index_relid, x.sample_ts desc
                  ) ix where coalesce(ix.is_valid, true) = false or coalesce(ix.is_ready, true) = false), 0) as invalid_indexes
                from control.instance_inventory i
                where i.is_active and i.bootstrap_state = 'ready'
                order by i.display_name
                """);

            for (Map<String, Object> inst : instances) {
                long tempFiles = toLong(inst.get("temp_files"));
                long tempBytes = toLong(inst.get("temp_bytes"));
                long deadlocks = toLong(inst.get("deadlocks"));
                long invalidIndexes = toLong(inst.get("invalid_indexes"));
                double cachePct = toDouble(inst.get("cache_pct"));
                String status = "OK";
                if (invalidIndexes > 0) status = "CHECK";
                if (tempFiles > 100 || deadlocks > 0 || cachePct < 95) status = "WARN";

                sb.append("[").append(status).append("] ").append(inst.get("display_name"));
                sb.append(" | TPS ").append(inst.get("avg_tps"));
                sb.append(" | Conn ").append(inst.get("connections"));
                sb.append(" | WAL: ").append(humanBytes(toLong(inst.get("wal_bytes"))));
                sb.append(" | Cache: ").append(cachePct).append("%");
                sb.append(" | Temp: ").append(tempFiles).append(" / ").append(humanBytes(tempBytes));
                sb.append(" | Deadlock: ").append(deadlocks);
                sb.append(" | Invalid index: ").append(invalidIndexes).append("\n");
            }
        } catch (Exception e) {
            sb.append("Instance bilgileri alinamadi: ").append(e.getMessage()).append("\n");
        }
        return sb.toString();
    }

    private String buildDailyEventReport() {
        StringBuilder sb = new StringBuilder();
        try {
            Map<String, Object> total = jdbc.queryForMap("""
                select count(*) as total_events
                from ops.alert a
                where a.alert_source in ('system', 'adaptive')
                  and (a.first_seen_at > now() - interval '24 hours'
                       or a.last_seen_at > now() - interval '24 hours')
                """);
            long totalEvents = toLong(total.get("total_events"));
            if (totalEvents == 0) return "";

            sb.append("Gunluk Olay Ozeti (son 24h)\n");
            sb.append("Toplam olay: ").append(totalEvents).append("\n\n");

            List<Map<String, Object>> byCode = jdbc.queryForList("""
                select a.alert_code, a.severity, count(*) as event_count,
                       count(*) filter (where a.status = 'open') as open_count,
                       max(a.last_seen_at) as last_seen_at
                from ops.alert a
                where a.alert_source in ('system', 'adaptive')
                  and (a.first_seen_at > now() - interval '24 hours'
                       or a.last_seen_at > now() - interval '24 hours')
                group by a.alert_code, a.severity
                order by count(*) desc,
                         case a.severity
                           when 'emergency' then 1
                           when 'critical' then 2
                           when 'error' then 3
                           when 'warning' then 4
                           else 5
                         end,
                         a.alert_code
                limit 20
                """);
            sb.append("Kod/severity dagilimi:\n");
            for (Map<String, Object> row : byCode) {
                sb.append("- ").append(row.get("alert_code"))
                  .append(" [").append(row.get("severity")).append("]: ")
                  .append(row.get("event_count")).append(" olay");
                long openCount = toLong(row.get("open_count"));
                if (openCount > 0) sb.append(" (").append(openCount).append(" open)");
                sb.append("\n");
            }

            List<Map<String, Object>> byInstance = jdbc.queryForList("""
                select coalesce(i.display_name, '(global)') as instance_name,
                       coalesce(i.host, '-') as host,
                       count(*) as event_count,
                       count(*) filter (where a.severity in ('critical', 'emergency')) as critical_count,
                       count(*) filter (where a.severity = 'error') as error_count,
                       count(*) filter (where a.severity = 'warning') as warning_count,
                       count(*) filter (where a.status = 'open') as open_count
                from ops.alert a
                left join control.instance_inventory i on i.instance_pk = a.instance_pk
                where a.alert_source in ('system', 'adaptive')
                  and (a.first_seen_at > now() - interval '24 hours'
                       or a.last_seen_at > now() - interval '24 hours')
                group by coalesce(i.display_name, '(global)'), coalesce(i.host, '-')
                order by count(*) desc, coalesce(i.display_name, '(global)')
                limit 20
                """);
            sb.append("\nInstance/host dagilimi:\n");
            for (Map<String, Object> row : byInstance) {
                sb.append("- ").append(row.get("instance_name"))
                  .append(" (").append(row.get("host")).append("): ")
                  .append(row.get("event_count")).append(" olay");
                long criticalCount = toLong(row.get("critical_count"));
                long errorCount = toLong(row.get("error_count"));
                long warningCount = toLong(row.get("warning_count"));
                long openCount = toLong(row.get("open_count"));
                List<String> parts = new ArrayList<>();
                if (criticalCount > 0) parts.add("critical " + criticalCount);
                if (errorCount > 0) parts.add("error " + errorCount);
                if (warningCount > 0) parts.add("warning " + warningCount);
                if (openCount > 0) parts.add("open " + openCount);
                if (!parts.isEmpty()) sb.append(" [").append(String.join(", ", parts)).append("]");
                sb.append("\n");
            }
        } catch (Exception e) {
            sb.append("Olay ozeti alinamadi: ").append(e.getMessage()).append("\n");
        }
        return sb.toString();
    }

    // =========================================================================
    // Haftalik Kapasite Rapor
    // =========================================================================

    /**
     * Haftalik kapasite raporu uretir ve bildirim kanallarina gonderir.
     * Trend karsilastirmasi: bu hafta vs gecen hafta.
     */
    public void generateAndSendWeeklyReport() {
        generateAndSendWeeklyReport(false, OffsetDateTime.now(ZoneOffset.UTC));
    }

    private long generateAndSendWeeklyReport(boolean manual, OffsetDateTime periodEnd) {
        if (!manual && !isWeeklyEnabled()) {
            log.info("Haftalik rapor devre disi (config), atlandi");
            return -1;
        }
        if (!manual && alreadySentToday("weekly")) {
            log.info("Haftalik rapor bugun zaten gonderilmis (DB), atlandi");
            return -1;
        }
        log.info("Haftalik rapor uretiliyor...");
        OffsetDateTime end = periodEnd.withOffsetSameInstant(ZoneOffset.UTC);
        String title = (manual ? "[Manuel] " : "") + "📈 pgstat Haftalık Kapasite Raporu — " + end.toLocalDate();
        try {
            String body = buildWeeklyReport(end);
            if (body == null || body.isBlank()) {
                log.warn("Haftalik rapor bos uretildi, gonderim atlandi");
                return -1;
            }
            SendResult result = sendReportToChannels(title, body);
            long reportId = -1;
            try {
                reportId = reportHistoryRepo.insert("weekly", title, body,
                    result.recipientsJson(), result.status(),
                    result.channelsCount(), result.errorMessage());
            } catch (Exception e) {
                log.warn("Rapor history kaydi yazilamadi: {}", e.getMessage());
            }
            log.info("Haftalik rapor gonderildi (status={}, channels={})",
                result.status(), result.channelsCount());
            return reportId;
        } catch (Exception e) {
            log.warn("Haftalik rapor hatasi: {}", e.getMessage());
            throw e;
        }
    }

    private String buildWeeklyReport(OffsetDateTime periodEnd) {
        StringBuilder sb = new StringBuilder();
        OffsetDateTime end = periodEnd.withOffsetSameInstant(ZoneOffset.UTC);
        OffsetDateTime weekStart = end.minusDays(7);
        OffsetDateTime previousWeekStart = weekStart.minusDays(7);
        sb.append("📈 **pgstat Haftalık Kapasite Raporu**\n");
        sb.append("Aralık: ").append(REPORT_RANGE_FMT.format(weekStart))
          .append(" -> ").append(REPORT_RANGE_FMT.format(end)).append("\n");
        sb.append("Karşılaştırma: ").append(REPORT_RANGE_FMT.format(previousWeekStart))
          .append(" -> ").append(REPORT_RANGE_FMT.format(weekStart)).append("\n\n");

        try {
            // Bu hafta vs gecen hafta karsilastirmasi
            Map<String, Object> thisWeek = jdbc.queryForMap("""
                select
                  coalesce(sum(xact_commit_delta + xact_rollback_delta), 0) as total_xact,
                  coalesce(sum(temp_files_delta), 0) as temp_files,
                  coalesce(sum(deadlocks_delta), 0) as deadlocks
                from fact.pg_database_delta
                where sample_ts > ? and sample_ts <= ?
                """, weekStart, end);
            Map<String, Object> lastWeek = jdbc.queryForMap("""
                select
                  coalesce(sum(xact_commit_delta + xact_rollback_delta), 0) as total_xact,
                  coalesce(sum(temp_files_delta), 0) as temp_files,
                  coalesce(sum(deadlocks_delta), 0) as deadlocks
                from fact.pg_database_delta
                where sample_ts > ? and sample_ts <= ?
                """, previousWeekStart, weekStart);

            long thisXact = toLong(thisWeek.get("total_xact"));
            long lastXact = toLong(lastWeek.get("total_xact"));
            long thisTps = thisXact / (7 * 86400);
            long lastTps = lastXact / (7 * 86400);
            String tpsChange = lastTps > 0 ? String.format("%+d%%", (thisTps - lastTps) * 100 / lastTps) : "—";

            sb.append("**Trend (bu hafta vs geçen hafta):**\n");
            sb.append("• TPS: ").append(thisTps).append(" (geçen: ").append(lastTps).append(", ").append(tpsChange).append(")\n");
            sb.append("• Temp files: ").append(thisWeek.get("temp_files")).append(" (geçen: ").append(lastWeek.get("temp_files")).append(")\n");
            sb.append("• Deadlock: ").append(thisWeek.get("deadlocks")).append(" (geçen: ").append(lastWeek.get("deadlocks")).append(")\n\n");

            // WAL trendi — uzun aralıklar için snapshot (7g) → hourly (90g) → daily (365g) fallback
            Map<String, Object> walThis = sumWalForRange(weekStart, end);
            Map<String, Object> walLast = sumWalForRange(previousWeekStart, weekStart);
            sb.append("• WAL/hafta: ").append(humanBytes(toLong(walThis.get("wal"))))
              .append(" (geçen: ").append(humanBytes(toLong(walLast.get("wal")))).append(")\n\n");

        } catch (Exception e) {
            sb.append("Trend bilgisi alinamadi: ").append(e.getMessage()).append("\n\n");
        }

        // Aksiyon onerileri
        sb.append("**Aksiyon Önerileri:**\n");
        try {
            // Unused index sayisi
            Integer unusedCount = jdbc.queryForObject("""
                with bounds as (
                  select now() - interval '30 days' as window_start,
                         now() as window_end,
                         interval '6 hours' as tolerance
                )
                select count(*) from (
                  select 1 from fact.pg_index_stat_delta i
                  cross join bounds b
                  where i.sample_ts >= b.window_start
                  group by i.instance_pk, i.schemaname, i.index_relname,
                           b.window_start, b.window_end, b.tolerance
                  having coalesce(sum(idx_scan_delta), 0) = 0
                     and min(i.sample_ts) <= b.window_start + b.tolerance
                     and max(i.sample_ts) >= b.window_end - b.tolerance
                ) sub
                """, Integer.class);
            if (unusedCount != null && unusedCount > 0) {
                sb.append("• ").append(unusedCount).append(" kullanılmayan index drop edilebilir\n");
            }

            Integer invalidIndexCount = jdbc.queryForObject("""
                select count(*) from (
                  select distinct on (i.instance_pk, i.dbid, i.index_relid)
                         i.is_valid, i.is_ready
                  from fact.pg_index_stat_delta i
                  order by i.instance_pk, i.dbid, i.index_relid, i.sample_ts desc
                ) x
                where coalesce(x.is_valid, true) = false
                   or coalesce(x.is_ready, true) = false
                """, Integer.class);
            if (invalidIndexCount != null && invalidIndexCount > 0) {
                sb.append("• ").append(invalidIndexCount).append(" invalid/not-ready index kontrol edilmeli\n");
            }

            // Temp file ureten instance sayisi
            Integer tempInstances = jdbc.queryForObject("""
                select count(distinct instance_pk) from fact.pg_database_delta
                where sample_ts > ? and sample_ts <= ? and temp_files_delta > 0
                """, Integer.class, weekStart, end);
            if (tempInstances != null && tempInstances > 0) {
                sb.append("• ").append(tempInstances).append(" instance temp file üretiyor (work_mem kontrol)\n");
            }
        } catch (Exception ignore) {}

        return sb.toString();
    }

    /**
     * UI/API tarafindan control.report_trigger tablosuna yazilan manuel rapor
     * isteklerini isler. Haftalik manuel rapor, request zamanindan onceki son
     * 7 gunu baz alir ve otomatik gunluk idempotency guard'ini bypass eder.
     */
    public void processPendingManualReportTriggers() {
        List<Map<String, Object>> triggers;
        try {
            triggers = jdbc.queryForList("""
                select trigger_id, report_type, requested_at
                from control.report_trigger
                where status = 'pending'
                order by requested_at
                limit 5
                """);
        } catch (Exception e) {
            log.debug("Manual report trigger tablosu okunamadi: {}", e.getMessage());
            return;
        }

        for (Map<String, Object> trigger : triggers) {
            long triggerId = toLong(trigger.get("trigger_id"));
            String reportType = String.valueOf(trigger.get("report_type"));
            int claimed = jdbc.update("""
                update control.report_trigger
                set status = 'running', started_at = now()
                where trigger_id = ? and status = 'pending'
                """, triggerId);
            if (claimed == 0) continue;

            try {
                long reportId;
                if ("weekly".equals(reportType)) {
                    OffsetDateTime periodEnd = toOffsetDateTime(trigger.get("requested_at"));
                    reportId = generateAndSendWeeklyReport(true, periodEnd);
                } else if ("daily".equals(reportType)) {
                    // Manuel gunluk: bugun zaten gonderilmis olsa bile force=true ile
                    // yeniden uret (test/elle tetikleme amacli). Idempotency guard bypass.
                    reportId = generateAndSendDailyReport(true);
                } else {
                    throw new IllegalArgumentException("Desteklenmeyen manuel rapor tipi: " + reportType);
                }
                jdbc.update("""
                    update control.report_trigger
                    set status = 'done', completed_at = now(), report_id = ?
                    where trigger_id = ?
                    """, reportId > 0 ? reportId : null, triggerId);
            } catch (Exception e) {
                String msg = e.getMessage() != null ? e.getMessage() : "unknown";
                jdbc.update("""
                    update control.report_trigger
                    set status = 'failed', completed_at = now(), error_message = ?
                    where trigger_id = ?
                    """, msg.substring(0, Math.min(1000, msg.length())), triggerId);
            }
        }
    }

    // =========================================================================
    // Bildirim gonderimi
    // =========================================================================

    private SendResult sendReportToChannels(String title, String body) {
        int successCount = 0;
        int failCount = 0;
        String firstError = null;
        List<String> recipients = new ArrayList<>();
        try {
            List<Map<String, Object>> channels = jdbc.queryForList(
                "select channel_id, channel_name, channel_type, config::text as config " +
                "from control.notification_channel where is_enabled = true");

            for (Map<String, Object> channel : channels) {
                String type = (String) channel.get("channel_type");
                Object channelId = channel.get("channel_id");
                try {
                    String config = (String) channel.get("config");
                    notificationService.sendReport(type, config, title, body);
                    successCount++;
                    // Kanal kaydi (id + type) — UI'da liste gostermek icin
                    recipients.add("{\"channel_id\":" + channelId
                        + ",\"channel_type\":\"" + type + "\","
                        + "\"status\":\"sent\"}");
                } catch (Exception e) {
                    failCount++;
                    if (firstError == null) firstError = e.getMessage();
                    recipients.add("{\"channel_id\":" + channelId
                        + ",\"channel_type\":\"" + type + "\","
                        + "\"status\":\"failed\"}");
                    log.debug("Rapor gonderim hatasi channel={}: {}",
                        channel.get("channel_name"), e.getMessage());
                }
            }
        } catch (Exception e) {
            log.warn("Rapor kanal listesi alinamadi: {}", e.getMessage());
            return new SendResult(0, "[]", "failed", e.getMessage());
        }

        String status;
        if (successCount == 0 && failCount == 0) status = "sent"; // hic kanal yok
        else if (failCount == 0) status = "sent";
        else if (successCount == 0) status = "failed";
        else status = "partial";

        String json = "[" + String.join(",", recipients) + "]";
        return new SendResult(successCount, json, status, firstError);
    }

    // =========================================================================
    // Yardimci
    // =========================================================================

    /**
     * Verilen aralık için toplam WAL üretimini döndürür.
     * Raw snapshot 7 gün, hourly rollup 90 gün, daily rollup 365 gün tutulduğu
     * için aralığın uzunluğuna göre uygun katmandan okur.
     */
    private Map<String, Object> sumWalForRange(OffsetDateTime from, OffsetDateTime to) {
        long daysSpan = java.time.Duration.between(from, to).toDays();
        try {
            if (daysSpan <= 6) {
                return jdbc.queryForMap(
                    "select coalesce(sum(period_wal_size_byte), 0) as wal " +
                    "from fact.pg_wal_snapshot where sample_ts > ? and sample_ts <= ?",
                    from, to);
            } else if (daysSpan <= 89) {
                return jdbc.queryForMap(
                    "select coalesce(sum(wal_bytes_total), 0) as wal " +
                    "from agg.pg_wal_hourly where hour_ts > ? and hour_ts <= ?",
                    from, to);
            } else {
                return jdbc.queryForMap(
                    "select coalesce(sum(wal_bytes_total), 0) as wal " +
                    "from agg.pg_wal_daily where day_ts > ? and day_ts <= ?",
                    from, to);
            }
        } catch (Exception e) {
            return Map.of("wal", 0L);
        }
    }

    private static long toLong(Object val) {
        if (val == null) return 0;
        return ((Number) val).longValue();
    }

    private static double toDouble(Object val) {
        if (val == null) return 0;
        return ((Number) val).doubleValue();
    }

    private static OffsetDateTime toOffsetDateTime(Object val) {
        if (val instanceof OffsetDateTime odt) return odt.withOffsetSameInstant(ZoneOffset.UTC);
        if (val instanceof java.sql.Timestamp ts) return ts.toInstant().atOffset(ZoneOffset.UTC);
        if (val instanceof java.util.Date date) return date.toInstant().atOffset(ZoneOffset.UTC);
        return OffsetDateTime.now(ZoneOffset.UTC);
    }

    private static String humanBytes(long bytes) {
        if (bytes >= 1_073_741_824) return String.format("%.1f GB", bytes / 1_073_741_824.0);
        if (bytes >= 1_048_576) return String.format("%.1f MB", bytes / 1_048_576.0);
        if (bytes >= 1_024) return String.format("%.1f KB", bytes / 1_024.0);
        return bytes + " B";
    }
}
