package com.pgstat.collector.service;

import com.pgstat.collector.model.AlertCode;
import com.pgstat.collector.repository.AlertRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

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

    public AlertService(AlertRepository alertRepo) {
        this.alertRepo = alertRepo;
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
     * Instance bazli alert olusturur (tum parametrelerle).
     */
    public void raiseInstanceAlert(AlertCode code, long instancePk,
                                   String serviceGroup, Long systemIdentifier,
                                   String title, String message, String detailsJson) {
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
        String alertKey = code.getCode() + ":" + code.getSourceComponent() + ":global";
        try {
            alertRepo.upsert(alertKey, code, null, null, null, title, message, null);
            log.debug("Job alert olusturuldu: {} — {}", alertKey, title);
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
    // Yardimci
    // =========================================================================

    /** Instance alert key olusturur: "alert_code:source_component:instancePk" */
    private String buildInstanceAlertKey(AlertCode code, long instancePk) {
        return code.getCode() + ":" + code.getSourceComponent() + ":" + instancePk;
    }
}
