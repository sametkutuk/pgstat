package com.pgstat.collector.service;

import com.pgstat.collector.model.AlertCode;
import com.pgstat.collector.repository.AlertRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

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

    public AlertService(AlertRepository alertRepo, AlertMessageRenderer renderer) {
        this.alertRepo = alertRepo;
        this.renderer = renderer;
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
        raiseInstanceAlert(code, instancePk, null, null, rendered[0], rendered[1], null);
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
        raiseJobAlert(code, null, title, message);
    }

    /**
     * Sablon destekli job alert. ctx null degilse alert_message_template'den
     * sablon cekilir; render basarisiz olursa fallback title/message kullanilir.
     */
    public void raiseJobAlert(AlertCode code, Map<String, Object> ctx,
                              String fallbackTitle, String fallbackMessage) {
        String alertKey = code.getCode() + ":" + code.getSourceComponent() + ":global";
        String[] rendered = renderTemplate(code, ctx, fallbackTitle, fallbackMessage);
        try {
            alertRepo.upsert(alertKey, code, null, null, null, rendered[0], rendered[1], null);
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
    // Yardimci
    // =========================================================================

    /** Instance alert key olusturur: "alert_code:source_component:instancePk" */
    private String buildInstanceAlertKey(AlertCode code, long instancePk) {
        return code.getCode() + ":" + code.getSourceComponent() + ":" + instancePk;
    }
}
