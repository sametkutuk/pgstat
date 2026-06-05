package com.pgstat.collector.service;

import com.pgstat.collector.model.AlertCode;
import com.pgstat.collector.repository.AlertRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Map;

/**
 * Alert olusturma/cozme facade'i.
 *
 * Collector'lar ve orkestrator bu servisi kullanarak ops.alert tablosuna
 * alert yazar veya mevcut alert'leri resolve eder.
 *
 * Alert key formati: "{alert_code}:{source_component}:{context_id}"
 * Ornek: "connection_failure:instance:42"
 */
@Service
public class AlertService {

    private static final Logger log = LoggerFactory.getLogger(AlertService.class);

    private final AlertRepository alertRepo;
    private final AlertMessageRenderer renderer;
    private final JdbcTemplate jdbc;
    private NotificationService notificationService;

    public AlertService(AlertRepository alertRepo, AlertMessageRenderer renderer, JdbcTemplate jdbc) {
        this.alertRepo = alertRepo;
        this.renderer = renderer;
        this.jdbc = jdbc;
    }

    @Autowired(required = false)
    public void setNotificationService(NotificationService notificationService) {
        this.notificationService = notificationService;
    }

    /** Transient alert'leri staleMinutes sonra otomatik kapat (proxy). */
    public int autoResolveStale(int staleMinutes) {
        return alertRepo.autoResolveStale(staleMinutes);
    }

    /**
     * Sablon render yardimcisi. Hata durumunda fallback metinler donulur.
     */
    private String[] renderTemplate(AlertCode code, Map<String, Object> ctx,
                                     String fallbackTitle, String fallbackMessage) {
        if (ctx == null) return new String[]{fallbackTitle, fallbackMessage};
        try {
            return renderer.renderForCode(code.getCode(), ctx, fallbackTitle, fallbackMessage);
        } catch (Exception e) {
            log.debug("Alert template render hatasi code={}: {}", code.getCode(), e.getMessage());
            return new String[]{fallbackTitle, fallbackMessage};
        }
    }

    // =========================================================================
    // Instance seviyesi alert'ler
    // =========================================================================

    /**
     * Instance bazli alert olusturur veya gunceller.
     *
     * @param code       alert kodu
     * @param instancePk hedef instance PK
     * @param title      alert basligi
     * @param message    detayli mesaj
     */
    public void raiseInstanceAlert(AlertCode code, long instancePk,
                                   String title, String message) {
        raiseInstanceAlert(code, instancePk, null, null, title, message, null);
    }

    /**
     * Sablon destekli instance alert. ctx null degilse alert_message_template'den
     * sablon cekilir; render basarisiz olursa fallback title/message kullanilir.
     */
    public void raiseInstanceAlert(AlertCode code, long instancePk,
                                   Map<String, Object> ctx,
                                   String fallbackTitle, String fallbackMessage) {
        String[] rendered = renderTemplate(code, ctx, fallbackTitle, fallbackMessage);

        // details_json: context bilgilerini kaydet (UI'da gösterilir)
        String detailsJson = null;
        if (ctx != null && !ctx.isEmpty()) {
            AlertDetailsBuilder details = new AlertDetailsBuilder().setKind("usage_summary");
            ctx.forEach((k, v) -> {
                if (v != null && !"severity".equals(k)) details.addContext(k, v);
            });
            detailsJson = details.build();
        }

        raiseInstanceAlert(code, instancePk, null, null, rendered[0], rendered[1], detailsJson);
    }

    /**
     * Instance bazli alert olusturur (tum parametrelerle).
     */
    public void raiseInstanceAlert(AlertCode code, long instancePk,
                                   String serviceGroup, Long systemIdentifier,
                                   String title, String message, String detailsJson) {
        // Config check: bu instance için bu alert aktif mi?
        String alertKey = buildInstanceAlertKey(code, instancePk);
        try {
            alertRepo.upsert(alertKey, code, instancePk,
                serviceGroup, systemIdentifier, title, message, detailsJson);
            log.debug("Alert olusturuldu: {} — {}", alertKey, title);
        } catch (Exception e) {
            // Alert yazma hatasi toplama akisini durdurmasin
            log.error("Alert yazma hatasi: {} — {}", alertKey, e.getMessage());
        }
    }

    /**
     * Instance bazli alert'i resolve eder.
     */
    public void resolveInstanceAlert(AlertCode code, long instancePk) {
        String alertKey = buildInstanceAlertKey(code, instancePk);
        try {
            alertRepo.resolve(alertKey);
            log.debug("Alert resolve edildi: {}", alertKey);
        } catch (Exception e) {
            log.error("Alert resolve hatasi: {} — {}", alertKey, e.getMessage());
        }
    }

    // =========================================================================
    // Job seviyesi alert'ler
    // =========================================================================

    /**
     * Job bazli alert olusturur (instance bagimsiz).
     *
     * @param code    alert kodu
     * @param title   alert basligi
     * @param message detayli mesaj
     */
    public void raiseJobAlert(AlertCode code, String title, String message) {
        raiseJobAlert(code, null, title, message);
    }

    /**
     * Sablon destekli job alert. ctx null degilse alert_message_template'den
     * sablon cekilir; render basarisiz olursa fallback title/message kullanilir.
     */
    public void raiseJobAlert(AlertCode code, Map<String, Object> ctx,
                              String fallbackTitle, String fallbackMessage) {
        // Config check: job alert global olarak aktif mi? (instance_pk = null)
        String alertKey = code.getCode() + ":" + code.getSourceComponent() + ":global";
        String[] rendered = renderTemplate(code, ctx, fallbackTitle, fallbackMessage);

        // details_json: job context bilgilerini kaydet
        String detailsJson = null;
        if (ctx != null && !ctx.isEmpty()) {
            AlertDetailsBuilder details = new AlertDetailsBuilder().setKind("usage_summary");
            ctx.forEach((k, v) -> {
                if (v != null && !"severity".equals(k)) details.addContext(k, v);
            });
            detailsJson = details.build();
        }

        try {
            alertRepo.upsert(alertKey, code, null, null, null, rendered[0], rendered[1], detailsJson);
            log.debug("Job alert olusturuldu: {} — {}", alertKey, rendered[0]);
        } catch (Exception e) {
            log.error("Job alert yazma hatasi: {} — {}", alertKey, e.getMessage());
        }
    }

    /**
     * Job bazli alert'i resolve eder.
     */
    public void resolveJobAlert(AlertCode code) {
        String alertKey = code.getCode() + ":" + code.getSourceComponent() + ":global";
        try {
            alertRepo.resolve(alertKey);
        } catch (Exception e) {
            log.error("Job alert resolve hatasi: {} — {}", alertKey, e.getMessage());
        }
    }

    // =========================================================================
    // System alert helper'lari
    // =========================================================================

    public void upsertSystemAlert(String alertCode, String alertKey, String severity,
                                  Long instancePk, String title, String message,
                                  String detailsJson) {
        List<Map<String, Object>> previousRows = jdbc.queryForList("""
            select alert_id, severity, status
            from ops.alert
            where alert_key = ?
            """, alertKey);
        Map<String, Object> previous = previousRows.isEmpty() ? null : previousRows.get(0);
        String previousSeverity = previous == null ? null : String.valueOf(previous.get("severity"));
        String previousStatus = previous == null ? null : String.valueOf(previous.get("status"));

        long alertId = jdbc.queryForObject("""
            insert into ops.alert (
              alert_key, alert_code, severity, status, source_component, alert_source,
              instance_pk, first_seen_at, last_seen_at, occurrence_count,
              title, message, details_json
            )
            values (?, ?, ?, 'open', 'system', 'system', ?, now(), now(), 1, ?, ?, ?::jsonb)
            on conflict (alert_key) do update
            set severity = excluded.severity,
                status = 'open',
                acknowledged_at = null,
                instance_pk = coalesce(excluded.instance_pk, ops.alert.instance_pk),
                last_seen_at = now(),
                title = excluded.title,
                message = excluded.message,
                details_json = excluded.details_json,
                occurrence_count = ops.alert.occurrence_count + 1,
                resolved_at = null,
                alert_source = 'system'
            returning alert_id
            """,
            Long.class,
            alertKey, alertCode, severity, instancePk, title, message, detailsJson
        );

        if (notificationService != null && shouldNotifySystemOpen(severity, previousSeverity, previousStatus)) {
            notificationService.notifyIfNeeded(alertId, alertKey, alertCode, severity, instancePk, title, message);
        }
    }

    public void resolveSystemAlert(String alertKey) {
        List<Map<String, Object>> rows = jdbc.queryForList("""
            select alert_id, alert_code, severity, instance_pk, title
            from ops.alert
            where alert_key = ? and status = 'open'
            """, alertKey);
        if (rows.isEmpty()) return;
        Map<String, Object> previous = rows.get(0);

        int updated = jdbc.update("""
            update ops.alert
            set status = 'resolved',
                resolved_at = now(),
                last_seen_at = now()
            where alert_key = ? and status = 'open'
            """, alertKey);

        if (updated > 0 && notificationService != null
                && "critical".equals(String.valueOf(previous.get("severity")))) {
            long alertId = ((Number) previous.get("alert_id")).longValue();
            Long instancePk = previous.get("instance_pk") == null ? null : ((Number) previous.get("instance_pk")).longValue();
            String alertCode = String.valueOf(previous.get("alert_code"));
            String title = "Resolved: " + String.valueOf(previous.get("title"));
            notificationService.notifyIfNeeded(alertId, alertKey, alertCode, "critical", instancePk,
                title, "System alert resolved");
        }
    }

    private boolean shouldNotifySystemOpen(String severity, String previousSeverity, String previousStatus) {
        if (!"warning".equals(severity) && !"critical".equals(severity)) return false;
        if (previousStatus == null || !"open".equals(previousStatus)) return true;
        return severityRank(severity) > severityRank(previousSeverity);
    }

    private int severityRank(String severity) {
        if ("critical".equals(severity)) return 3;
        if ("error".equals(severity)) return 2;
        if ("warning".equals(severity)) return 1;
        return 0;
    }

    // =========================================================================
    // Yardimci
    // =========================================================================

    /** Instance alert key olusturur: "alert_code:source_component:instancePk" */
    private String buildInstanceAlertKey(AlertCode code, long instancePk) {
        return code.getCode() + ":" + code.getSourceComponent() + ":" + instancePk;
    }
}
