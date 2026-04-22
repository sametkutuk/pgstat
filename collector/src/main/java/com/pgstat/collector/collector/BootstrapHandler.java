package com.pgstat.collector.collector;

import com.pgstat.collector.model.AlertCode;
import com.pgstat.collector.model.InstanceCapability;
import com.pgstat.collector.model.InstanceInfo;
import com.pgstat.collector.repository.AlertRepository;
import com.pgstat.collector.repository.InventoryRepository;
import com.pgstat.collector.service.SecretResolver;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Bootstrap state machine — yeni instance'lari ready durumuna getirir.
 *
 * State geçişleri:
 *   pending     → discovering  (baglanti + versiyon tespiti)
 *   discovering → baselining   (ilk sample alinir, delta yok)
 *   baselining  → enriching    (SQL text enrichment baslar)
 *   enriching   → ready        (tum hazirliklar tamamlandi)
 *
 * Hata durumlari:
 *   Herhangi bir adimda hata → bootstrap_failed alert + degraded state
 *   secret_ref hatasi → secret_ref_error alert + degraded state
 */
@Component
public class BootstrapHandler {

    private static final Logger log = LoggerFactory.getLogger(BootstrapHandler.class);

    private final DiscoveryCollector discoveryCollector;
    private final InventoryRepository inventoryRepo;
    private final AlertRepository alertRepo;

    public BootstrapHandler(DiscoveryCollector discoveryCollector,
                            InventoryRepository inventoryRepo,
                            AlertRepository alertRepo) {
        this.discoveryCollector = discoveryCollector;
        this.inventoryRepo = inventoryRepo;
        this.alertRepo = alertRepo;
    }

    /**
     * Instance'in su anki bootstrap_state'ine gore bir sonraki adimi calistirir.
     * Her cagri tek bir adim ilerler; bir sonraki poll'da devam edilir.
     *
     * @param instance bootstrap bekleyen instance
     */
    public void processBootstrapStep(InstanceInfo instance) {
        String state = instance.bootstrapState();
        log.debug("Bootstrap adimi: {} — state={}", instance.instanceId(), state);

        try {
            switch (state) {
                case "pending" -> handlePending(instance);
                case "discovering" -> handleDiscovering(instance);
                case "baselining" -> handleBaselining(instance);
                case "enriching" -> handleEnriching(instance);
                default -> log.warn("Beklenmeyen bootstrap state: {} — {}",
                        state, instance.instanceId());
            }
        } catch (SecretResolver.SecretResolveException e) {
            // Secret hatasi → ozel alert
            log.error("Bootstrap secret hatasi: {} — {}", instance.instanceId(), e.getMessage());
            raiseAlert(instance, AlertCode.SECRET_REF_ERROR,
                    "Secret cozumleme hatasi: " + instance.instanceId(),
                    e.getMessage());
            inventoryRepo.updateBootstrapState(instance.instancePk(), "degraded");

        } catch (Exception e) {
            // Genel hata → bootstrap_failed alert
            log.error("Bootstrap hatasi: {} state={} — {}",
                    instance.instanceId(), state, e.getMessage(), e);
            raiseAlert(instance, AlertCode.BOOTSTRAP_FAILED,
                    "Bootstrap basarisiz: " + instance.instanceId(),
                    state + " adiminda hata: " + e.getMessage());
            inventoryRepo.updateBootstrapState(instance.instancePk(), "degraded");
        }
    }

    // -------------------------------------------------------------------------
    // State handler'lari
    // -------------------------------------------------------------------------

    /** pending → discovering: Baglanti kur, versiyon tespit et */
    private void handlePending(InstanceInfo instance) {
        log.info("Bootstrap baslatiliyor: {}", instance.instanceId());
        inventoryRepo.updateBootstrapState(instance.instancePk(), "discovering");
    }

    /** discovering: Discovery calistir → basarili ise baselining'e gec */
    private void handleDiscovering(InstanceInfo instance) {
        InstanceCapability cap = discoveryCollector.discover(instance);
        if (cap == null) {
            // Discovery basarisiz — state discovering'de kalir, retry edilir
            log.warn("Discovery basarisiz, retry edilecek: {}", instance.instanceId());
            return;
        }

        // pg_stat_statements yoksa degraded'a gec (temel ozelligi eksik)
        if (!cap.hasPgStatStatements()) {
            log.warn("pg_stat_statements bulunamadi, degraded: {}", instance.instanceId());
            raiseAlert(instance, AlertCode.EXTENSION_MISSING,
                    "Extension eksik: " + instance.instanceId(),
                    "pg_stat_statements extension'i bulunamadi");
            inventoryRepo.updateBootstrapState(instance.instancePk(), "degraded");
            return;
        }

        inventoryRepo.updateBootstrapState(instance.instancePk(), "baselining");
        log.info("Discovery tamamlandi, baselining'e geciliyor: {}", instance.instanceId());
    }

    /**
     * baselining: Ilk sample alinir (cluster + statements baseline).
     * Delta hesaplanmaz — sadece onceki deger kaydedilir.
     * Basarili ise enriching'e gecer.
     */
    private void handleBaselining(InstanceInfo instance) {
        // Baselining adiminida ClusterCollector ve StatementsCollector
        // ilk sample'i alir. Bu adim Phase 1F ve 1G'de uygulanacak.
        // Simdilik state gecisini yap.
        inventoryRepo.updateBootstrapState(instance.instancePk(), "enriching");
        log.info("Baselining tamamlandi, enriching'e geciliyor: {}", instance.instanceId());
    }

    /**
     * enriching: SQL text enrichment yapilir.
     * query_text_id = NULL olan statement_series satirlari icin text cekilir.
     * Basarili ise ready'ye gecer.
     */
    private void handleEnriching(InstanceInfo instance) {
        // Enrichment adiminida TextEnricher calisir.
        // Bu adim Phase 1G'de uygulanacak.
        // Simdilik state gecisini yap.
        inventoryRepo.updateBootstrapState(instance.instancePk(), "ready");
        log.info("Bootstrap tamamlandi, ready: {}", instance.instanceId());
    }

    // -------------------------------------------------------------------------
    // Alert yardimcisi
    // -------------------------------------------------------------------------

    private void raiseAlert(InstanceInfo instance, AlertCode code,
                            String title, String message) {
        String alertKey = code.getCode() + ":" + code.getSourceComponent()
                + ":" + instance.instancePk();
        alertRepo.upsert(alertKey, code, instance.instancePk(),
                null, null, title, message, null);
    }
}
