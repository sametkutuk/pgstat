package com.pgstat.collector.repository;

import com.pgstat.collector.model.AlertCode;
import com.pgstat.collector.service.NotificationService;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * ops.alert tablosu icin upsert ve resolve islemleri.
 * Mimari dok: satir 3156-3205
 */
@Repository
public class AlertRepository {

    /**
     * Bildirim modu — ayni alert_key tekrar upsert edildiginde bildirim atilsin mi?
     *   ALWAYS     : her upsert'te bildir (mevcut davranis; spam korumasi NotificationService'te).
     *   FIRST_ONLY : sadece yeni alert, reopen (resolved/acknowledged -> open) veya severity
     *                degisiminde bildir. Ayni severity'de acik kalan alert sessiz kalir.
     *                (XID warning gibi: ilk kez + critical'e yukselince bildir, arada sus.)
     */
    public enum NotifyMode { ALWAYS, FIRST_ONLY }

    private final JdbcTemplate jdbc;
    private NotificationService notificationService;

    public AlertRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Circular dependency'den kaçınmak için setter injection */
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    public void setNotificationService(NotificationService notificationService) {
        this.notificationService = notificationService;
    }

    /**
     * Alert olusturur veya mevcudu gunceller (ON CONFLICT ile idempotent).
     * Ayni alert_key tekrar gelirse: occurrence_count artar, last_seen_at guncellenir.
     * Resolved durumundaysa tekrar 'open' olur.
     *
     * @param alertKey         benzersiz anahtar (ornek: "connection_failure:instance:42")
     * @param alertCode        AlertCode enum degeri
     * @param instancePk       ilgili instance (null olabilir — job seviyesi alert'ler icin)
     * @param serviceGroup     service grubu (null olabilir)
     * @param systemIdentifier PG system identifier (null olabilir)
     * @param title            alert basligi
     * @param message          detayli mesaj
     * @param detailsJson      ek JSON detay (null olabilir)
     * @return olusturulan veya guncellenen alert_id
     */
    public long upsert(String alertKey, AlertCode alertCode, Long instancePk,
                       String serviceGroup, Long systemIdentifier,
                       String title, String message, String detailsJson) {
        return upsert(alertKey, alertCode, instancePk, serviceGroup, systemIdentifier,
            title, message, detailsJson, NotifyMode.ALWAYS);
    }

    /**
     * upsert + bildirim modu. FIRST_ONLY ile ayni severity'de acik kalan alert sessiz kalir;
     * yeni/reopen/severity-degisimi durumunda bildirilir.
     */
    public long upsert(String alertKey, AlertCode alertCode, Long instancePk,
                       String serviceGroup, Long systemIdentifier,
                       String title, String message, String detailsJson, NotifyMode notifyMode) {
        // FIRST_ONLY icin: upsert'ten ONCE mevcut alert'in durumunu oku.
        // Yeni satir / reopen / severity-degisimi -> bildir, aksi -> sus.
        boolean shouldNotify = true;
        if (notifyMode == NotifyMode.FIRST_ONLY) {
            shouldNotify = decideFirstOnlyNotify(alertKey, alertCode.getDefaultSeverity());
        }

        // source_component'a göre alert_source belirle
        // 'system' (SystemHealth) → 'system', 'rule' (user-defined) → 'user_rule'
        String src = alertCode.getSourceComponent();
        String alertSource;
        if ("adaptive".equals(src)) {
            alertSource = "adaptive";
        } else if ("rule".equals(src)) {
            alertSource = "user_rule";
        } else {
            alertSource = "system";
        }
        long alertId = jdbc.queryForObject("""
            insert into ops.alert (
              alert_key,
              alert_code,
              severity,
              status,
              source_component,
              instance_pk,
              service_group,
              system_identifier,
              first_seen_at,
              last_seen_at,
              occurrence_count,
              title,
              message,
              details_json,
              alert_source
            )
            values (?, ?, ?, 'open', ?, ?, ?, ?, now(), now(), 1, ?, ?, ?::jsonb, ?)
            on conflict (alert_key) do update
            set severity = excluded.severity,
                status = case
                  when ops.alert.status in ('resolved', 'acknowledged') then 'open'
                  else ops.alert.status
                end,
                acknowledged_at = case
                  when ops.alert.status = 'acknowledged' then null
                  else ops.alert.acknowledged_at
                end,
                instance_pk = coalesce(excluded.instance_pk, ops.alert.instance_pk),
                service_group = coalesce(excluded.service_group, ops.alert.service_group),
                system_identifier = coalesce(excluded.system_identifier, ops.alert.system_identifier),
                last_seen_at = now(),
                title = excluded.title,
                message = excluded.message,
                details_json = excluded.details_json,
                alert_source = excluded.alert_source,
                occurrence_count = ops.alert.occurrence_count + 1,
                resolved_at = null
            returning alert_id
            """,
            Long.class,
            alertKey,
            alertCode.getCode(),
            alertCode.getDefaultSeverity(),
            alertCode.getSourceComponent(),
            instancePk,
            serviceGroup,
            systemIdentifier,
            title,
            message,
            detailsJson,
            alertSource
        );

        // Bildirim gönder (FIRST_ONLY modunda sadece yeni/reopen/severity-degisiminde)
        if (shouldNotify) {
            fireNotification(alertId, alertKey, alertCode.getCode(), alertCode.getDefaultSeverity(), instancePk, title, message);
        }

        return alertId;
    }

    /**
     * FIRST_ONLY modu icin bildirim karari: upsert'ten ONCE mevcut alert durumuna bak.
     *   - Alert yoksa (yeni)                       -> bildir
     *   - Mevcut status 'resolved'/'acknowledged'  -> reopen olacak, bildir
     *   - Mevcut severity yeni severity'den farkli  -> severity degisti, bildir
     *   - Aksi (zaten 'open', ayni severity)        -> sus
     */
    private boolean decideFirstOnlyNotify(String alertKey, String newSeverity) {
        try {
            var rows = jdbc.query(
                "select status, severity from ops.alert where alert_key = ?",
                (rs, n) -> new String[]{ rs.getString("status"), rs.getString("severity") },
                alertKey
            );
            if (rows.isEmpty()) {
                return true; // yeni alert
            }
            String status = rows.get(0)[0];
            String severity = rows.get(0)[1];
            if ("resolved".equals(status) || "acknowledged".equals(status)) {
                return true; // reopen
            }
            return !java.util.Objects.equals(severity, newSeverity); // severity degisti mi?
        } catch (Exception e) {
            return true; // emin degilsek bildir (sessiz kalmaktansa)
        }
    }

    /**
     * Kullanici tanimli kural alert'i — severity dinamik, rule_id kaydedilir.
     */
    public long upsertWithSeverity(String alertKey, AlertCode alertCode, String severity,
                                   Long instancePk, String serviceGroup,
                                   String title, String message) {
        return upsertWithSeverity(alertKey, alertCode, severity, instancePk, serviceGroup, title, message, null);
    }

    public long upsertWithSeverity(String alertKey, AlertCode alertCode, String severity,
                                   Long instancePk, String serviceGroup,
                                   String title, String message, Long ruleId) {
        return upsertWithSeverity(alertKey, alertCode, severity, instancePk, serviceGroup,
            title, message, ruleId, null);
    }

    public long upsertWithSeverity(String alertKey, AlertCode alertCode, String severity,
                                   Long instancePk, String serviceGroup,
                                   String title, String message, Long ruleId, String detailsJson) {
        String alertSource = ruleId != null ? "user_rule" : "system";
        long alertId = jdbc.queryForObject("""
            insert into ops.alert (
              alert_key, alert_code, severity, status, source_component,
              instance_pk, service_group, first_seen_at, last_seen_at,
              occurrence_count, title, message, rule_id, details_json, alert_source
            )
            values (?, ?, ?, 'open', ?, ?, ?, now(), now(), 1, ?, ?, ?, ?::jsonb, ?)
            on conflict (alert_key) do update
            set severity = excluded.severity,
                status = case
                  when ops.alert.status in ('resolved', 'acknowledged') then 'open'
                  else ops.alert.status
                end,
                acknowledged_at = case
                  when ops.alert.status = 'acknowledged' then null
                  else ops.alert.acknowledged_at
                end,
                instance_pk = coalesce(excluded.instance_pk, ops.alert.instance_pk),
                service_group = coalesce(excluded.service_group, ops.alert.service_group),
                last_seen_at = now(),
                title = excluded.title,
                message = excluded.message,
                rule_id = coalesce(excluded.rule_id, ops.alert.rule_id),
                details_json = excluded.details_json,
                alert_source = excluded.alert_source,
                occurrence_count = ops.alert.occurrence_count + 1,
                resolved_at = null
            returning alert_id
            """,
            Long.class,
            alertKey, alertCode.getCode(), severity, alertCode.getSourceComponent(),
            instancePk, serviceGroup, title, message, ruleId, detailsJson, alertSource
        );

        // Bildirim gönder
        fireNotification(alertId, alertKey, alertCode.getCode(), severity, instancePk, title, message);

        return alertId;
    }

    /** Alert'i resolved olarak isaretler. Zaten resolved ise degismez. */
    public void resolve(String alertKey) {
        jdbc.update("""
            update ops.alert
            set status = 'resolved',
                resolved_at = now(),
                last_seen_at = now()
            where alert_key = ?
              and status <> 'resolved'
            """,
            alertKey
        );
    }

    /**
     * Alert'i resolved yapar VE gercekten open->resolved gecisi olduysa "risk gecti"
     * bildirimi gonderir. Zaten resolved ise hicbir sey yapmaz (tekrar bildirmez).
     * Title onune "Resolved: " eklenir ki bildirim kanali bunu cozulme olarak gostersin.
     */
    public void resolveAndNotify(String alertKey, String title, String message) {
        // Once severity'yi al (bildirim icin) ve resolve et — tek transaction'da
        // RETURNING ile gercekten guncellenen satiri yakala.
        var rows = jdbc.query("""
            update ops.alert
            set status = 'resolved',
                resolved_at = now(),
                last_seen_at = now()
            where alert_key = ?
              and status <> 'resolved'
            returning alert_id, severity, instance_pk
            """,
            (rs, n) -> new Object[]{ rs.getLong("alert_id"), rs.getString("severity"),
                                     (Long) rs.getObject("instance_pk") },
            alertKey
        );
        if (rows.isEmpty()) {
            return; // zaten resolved'di, bildirim yok
        }
        long alertId = (Long) rows.get(0)[0];
        String severity = (String) rows.get(0)[1];
        Long instancePk = (Long) rows.get(0)[2];
        // alert_code'u resolve bildiriminde cooldown'i bypass etmek icin "Resolved:" prefix
        // NotificationService systemResolved mantigi title "Resolved:" ile baslayinca devreye girer.
        String resolvedTitle = "Resolved: " + title;
        fireNotification(alertId, alertKey, "adaptive_resolved", severity, instancePk, resolvedTitle, message);
    }

    /**
     * Auto-resolve: transient (dinamik koşullara bağlı) açık alert'ler son tetiklemeden
     * sonra X dakika boyunca yeniden tetiklenmediyse otomatik 'resolved' olur.
     *
     * Bootstrap/auth/extension gibi PERSISTENT (durum düzelene kadar açık kalmalı)
     * alert kodları DAHIL EDİLMEZ.
     *
     * @param staleMinutes son tetiklemeden bu kadar süre geçtiyse kapat (default 120)
     * @return resolved edilen alert sayısı
     */
    public int autoResolveStale(int staleMinutes) {
        return jdbc.update("""
            update ops.alert
            set status = 'resolved',
                resolved_at = now()
            where status = 'open'
              and last_seen_at < now() - make_interval(mins => ?)
              and alert_code in (
                -- Stale auto-resolve closes transient alerts not refreshed recently.
                -- Burada sadece stats_reset_detected kaldi: event tipi, manuel ACK daha
                -- mantikli ama stale fallback gelecekte istenirse kapatabilir.
                'stats_reset_detected'
              )
            """, staleMinutes);
    }

    /** Bildirim servisine async olarak iletir. Hata olursa alert akışını bozmaz. */
    private void fireNotification(long alertId, String alertKey, String alertCode, String severity,
                                   Long instancePk, String title, String message) {
        if (notificationService == null) return;
        try {
            notificationService.notifyIfNeeded(alertId, alertKey, alertCode, severity, instancePk, title, message);
        } catch (Exception e) {
            // Bildirim hatası alert akışını kesmemeli
        }
    }
}
