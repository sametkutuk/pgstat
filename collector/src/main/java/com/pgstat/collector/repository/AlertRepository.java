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
              details_json
            )
            values (?, ?, ?, 'open', ?, ?, ?, ?, now(), now(), 1, ?, ?, ?::jsonb)
            on conflict (alert_key) do update
            set severity = excluded.severity,
                status = case
                  when ops.alert.status = 'resolved' then 'open'
                  else ops.alert.status
                end,
                instance_pk = coalesce(excluded.instance_pk, ops.alert.instance_pk),
                service_group = coalesce(excluded.service_group, ops.alert.service_group),
                system_identifier = coalesce(excluded.system_identifier, ops.alert.system_identifier),
                last_seen_at = now(),
                title = excluded.title,
                message = excluded.message,
                details_json = excluded.details_json,
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
            detailsJson
        );

        // Bildirim gönder
        fireNotification(alertId, alertKey, alertCode.getDefaultSeverity(), instancePk, title, message);

        return alertId;
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
        long alertId = jdbc.queryForObject("""
            insert into ops.alert (
              alert_key, alert_code, severity, status, source_component,
              instance_pk, service_group, first_seen_at, last_seen_at,
              occurrence_count, title, message, rule_id
            )
            values (?, ?, ?, 'open', ?, ?, ?, now(), now(), 1, ?, ?, ?)
            on conflict (alert_key) do update
            set severity = excluded.severity,
                status = case
                  when ops.alert.status = 'resolved' then 'open'
                  else ops.alert.status
                end,
                instance_pk = coalesce(excluded.instance_pk, ops.alert.instance_pk),
                service_group = coalesce(excluded.service_group, ops.alert.service_group),
                last_seen_at = now(),
                title = excluded.title,
                message = excluded.message,
                rule_id = coalesce(excluded.rule_id, ops.alert.rule_id),
                occurrence_count = ops.alert.occurrence_count + 1,
                resolved_at = null
            returning alert_id
            """,
            Long.class,
            alertKey, alertCode.getCode(), severity, alertCode.getSourceComponent(),
            instancePk, serviceGroup, title, message, ruleId
        );

        // Bildirim gönder
        fireNotification(alertId, alertKey, severity, instancePk, title, message);

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

    /** Bildirim servisine async olarak iletir. Hata olursa alert akışını bozmaz. */
    private void fireNotification(long alertId, String alertKey, String severity,
                                   Long instancePk, String title, String message) {
        if (notificationService == null) return;
        try {
            notificationService.notifyIfNeeded(alertId, alertKey, severity, instancePk, title, message);
        } catch (Exception e) {
            // Bildirim hatası alert akışını kesmemeli
        }
    }
}
