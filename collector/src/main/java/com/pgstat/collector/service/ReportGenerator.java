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
    public void generateAndSendDailyReport() {
        if (!isDailyEnabled()) {
            log.info("Gunluk rapor devre disi (config), atlandi");
            return;
        }
        // DB-bazlı idempotency: bugün zaten gönderilmişse atla.
        // In-memory flag collector restart'ta sıfırlanıyordu → restart UTC 06:00-06:59
        // arasındaysa rapor 2. kez gönderiliyordu. Bu kontrol restart'a karşı korur.
        if (alreadySentToday("daily")) {
            log.info("Gunluk rapor bugun zaten gonderilmis (DB), atlandi");
            return;
        }
        log.info("Gunluk rapor uretiliyor...");
        String title = "📊 pgstat Günlük Özet — " + LocalDate.now(ZoneOffset.UTC);
        try {
            String body = buildDailyReport();
            if (body == null || body.isBlank()) {
                log.warn("Gunluk rapor bos uretildi, gonderim atlandi");
                return;
            }
            SendResult result = sendReportToChannels(title, body);
            // History kaydi (basari/kismi/hata fark etmeksizin)
            try {
                reportHistoryRepo.insert("daily", title, body,
                    result.recipientsJson(), result.status(),
                    result.channelsCount(), result.errorMessage());
            } catch (Exception e) {
                log.warn("Rapor history kaydi yazilamadi: {}", e.getMessage());
            }
            log.info("Gunluk rapor gonderildi (status={}, channels={})",
                result.status(), result.channelsCount());
        } catch (Exception e) {
            log.warn("Gunluk rapor hatasi: {}", e.getMessage());
        }
    }

    private String buildDailyReport() {
        StringBuilder sb = new StringBuilder();
        String today = LocalDate.now(ZoneOffset.UTC).toString();
        sb.append("📊 **pgstat Günlük Özet** — ").append(today).append("\n\n");

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

            sb.append("**Fleet:** ").append(fleet.get("total")).append(" instance (")
              .append(fleet.get("ready")).append(" ready, ")
              .append(fleet.get("degraded")).append(" degraded) · ")
              .append(openAlerts).append(" açık alert\n\n");
        } catch (Exception e) {
            sb.append("Fleet bilgisi alinamadi\n\n");
        }

        // Per-instance ozet
        sb.append("**Per-Instance (son 24h):**\n");
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
                  coalesce((select sum(deadlocks_delta) from fact.pg_database_delta d
                    where d.instance_pk = i.instance_pk and d.sample_ts > now() - interval '24 hours'), 0) as deadlocks
                from control.instance_inventory i
                where i.is_active and i.bootstrap_state = 'ready'
                order by i.display_name
                """);

            for (Map<String, Object> inst : instances) {
                String status = "🟢";
                long tempFiles = toLong(inst.get("temp_files"));
                long deadlocks = toLong(inst.get("deadlocks"));
                double cachePct = toDouble(inst.get("cache_pct"));
                if (tempFiles > 100 || deadlocks > 0 || cachePct < 95) status = "🟡";

                sb.append(status).append(" **").append(inst.get("display_name")).append("**\n");
                sb.append("  TPS: ").append(inst.get("avg_tps"));
                sb.append(" | Bağlantı: ").append(inst.get("connections"));
                sb.append(" | WAL: ").append(humanBytes(toLong(inst.get("wal_bytes"))));
                sb.append(" | Cache: ").append(cachePct).append("%");
                sb.append(" | Temp: ").append(tempFiles);
                sb.append(" | Deadlock: ").append(deadlocks).append("\n\n");
            }
        } catch (Exception e) {
            sb.append("Instance bilgileri alinamadi: ").append(e.getMessage()).append("\n");
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
        if (!isWeeklyEnabled()) {
            log.info("Haftalik rapor devre disi (config), atlandi");
            return;
        }
        if (alreadySentToday("weekly")) {
            log.info("Haftalik rapor bugun zaten gonderilmis (DB), atlandi");
            return;
        }
        log.info("Haftalik rapor uretiliyor...");
        String title = "📈 pgstat Haftalık Kapasite Raporu — " + LocalDate.now(ZoneOffset.UTC);
        try {
            String body = buildWeeklyReport();
            if (body == null || body.isBlank()) {
                log.warn("Haftalik rapor bos uretildi, gonderim atlandi");
                return;
            }
            SendResult result = sendReportToChannels(title, body);
            try {
                reportHistoryRepo.insert("weekly", title, body,
                    result.recipientsJson(), result.status(),
                    result.channelsCount(), result.errorMessage());
            } catch (Exception e) {
                log.warn("Rapor history kaydi yazilamadi: {}", e.getMessage());
            }
            log.info("Haftalik rapor gonderildi (status={}, channels={})",
                result.status(), result.channelsCount());
        } catch (Exception e) {
            log.warn("Haftalik rapor hatasi: {}", e.getMessage());
        }
    }

    private String buildWeeklyReport() {
        StringBuilder sb = new StringBuilder();
        LocalDate today = LocalDate.now(ZoneOffset.UTC);
        LocalDate weekStart = today.minusDays(7);
        sb.append("📈 **pgstat Haftalık Kapasite Raporu**\n");
        sb.append("📅 ").append(weekStart).append(" → ").append(today).append("\n\n");

        try {
            // Bu hafta vs gecen hafta karsilastirmasi
            Map<String, Object> thisWeek = jdbc.queryForMap("""
                select
                  coalesce(sum(xact_commit_delta + xact_rollback_delta), 0) as total_xact,
                  coalesce(sum(temp_files_delta), 0) as temp_files,
                  coalesce(sum(deadlocks_delta), 0) as deadlocks
                from fact.pg_database_delta
                where sample_ts > now() - interval '7 days'
                """);
            Map<String, Object> lastWeek = jdbc.queryForMap("""
                select
                  coalesce(sum(xact_commit_delta + xact_rollback_delta), 0) as total_xact,
                  coalesce(sum(temp_files_delta), 0) as temp_files,
                  coalesce(sum(deadlocks_delta), 0) as deadlocks
                from fact.pg_database_delta
                where sample_ts > now() - interval '14 days'
                  and sample_ts <= now() - interval '7 days'
                """);

            long thisXact = toLong(thisWeek.get("total_xact"));
            long lastXact = toLong(lastWeek.get("total_xact"));
            long thisTps = thisXact / (7 * 86400);
            long lastTps = lastXact / (7 * 86400);
            String tpsChange = lastTps > 0 ? String.format("%+d%%", (thisTps - lastTps) * 100 / lastTps) : "—";

            sb.append("**Trend (bu hafta vs geçen hafta):**\n");
            sb.append("• TPS: ").append(thisTps).append(" (geçen: ").append(lastTps).append(", ").append(tpsChange).append(")\n");
            sb.append("• Temp files: ").append(thisWeek.get("temp_files")).append(" (geçen: ").append(lastWeek.get("temp_files")).append(")\n");
            sb.append("• Deadlock: ").append(thisWeek.get("deadlocks")).append(" (geçen: ").append(lastWeek.get("deadlocks")).append(")\n\n");

            // WAL trendi
            Map<String, Object> walThis = jdbc.queryForMap(
                "select coalesce(sum(period_wal_size_byte), 0) as wal from fact.pg_wal_snapshot where sample_ts > now() - interval '7 days'");
            Map<String, Object> walLast = jdbc.queryForMap(
                "select coalesce(sum(period_wal_size_byte), 0) as wal from fact.pg_wal_snapshot where sample_ts > now() - interval '14 days' and sample_ts <= now() - interval '7 days'");
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
                select count(*) from (
                  select 1 from fact.pg_index_stat_delta i
                  where i.sample_ts > now() - interval '30 days'
                  group by i.instance_pk, i.schemaname, i.indexrelname
                  having coalesce(sum(idx_scan_delta), 0) = 0
                ) sub
                """, Integer.class);
            if (unusedCount != null && unusedCount > 0) {
                sb.append("• ").append(unusedCount).append(" kullanılmayan index drop edilebilir\n");
            }

            // Temp file ureten instance sayisi
            Integer tempInstances = jdbc.queryForObject("""
                select count(distinct instance_pk) from fact.pg_database_delta
                where sample_ts > now() - interval '7 days' and temp_files_delta > 0
                """, Integer.class);
            if (tempInstances != null && tempInstances > 0) {
                sb.append("• ").append(tempInstances).append(" instance temp file üretiyor (work_mem kontrol)\n");
            }
        } catch (Exception ignore) {}

        return sb.toString();
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

    private static long toLong(Object val) {
        if (val == null) return 0;
        return ((Number) val).longValue();
    }

    private static double toDouble(Object val) {
        if (val == null) return 0;
        return ((Number) val).doubleValue();
    }

    private static String humanBytes(long bytes) {
        if (bytes >= 1_073_741_824) return String.format("%.1f GB", bytes / 1_073_741_824.0);
        if (bytes >= 1_048_576) return String.format("%.1f MB", bytes / 1_048_576.0);
        if (bytes >= 1_024) return String.format("%.1f KB", bytes / 1_024.0);
        return bytes + " B";
    }
}
