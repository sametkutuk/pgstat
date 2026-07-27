package com.pgstat.collector.collector;

import com.pgstat.collector.model.AlertCode;
import com.pgstat.collector.model.InstanceCapability;
import com.pgstat.collector.model.InstanceInfo;
import com.pgstat.collector.repository.InventoryRepository;
import com.pgstat.collector.repository.StateRepository;
import com.pgstat.collector.service.AlertDetailsBuilder;
import com.pgstat.collector.service.AlertService;
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
    private final StateRepository stateRepo;
    private final AlertService alertService;

    public BootstrapHandler(DiscoveryCollector discoveryCollector,
                            InventoryRepository inventoryRepo,
                            StateRepository stateRepo,
                            AlertService alertService) {
        this.discoveryCollector = discoveryCollector;
        this.inventoryRepo = inventoryRepo;
        this.stateRepo = stateRepo;
        this.alertService = alertService;
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

        // 'degraded' instance retry zamani geldi → pending'den basla
        // (state guncel value pending degil ama queue bunu retry icin getirdi)
        if ("degraded".equals(state)) {
            log.info("Otomatik retry: {} — pending'e cekiliyor", instance.instanceId());
            inventoryRepo.updateBootstrapState(instance.instancePk(), "pending");
            return;
        }

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
            log.error("Bootstrap secret hatasi: {} — {}", instance.instanceId(), e.getMessage());
            String msg = "Secret cozumleme hatasi: " + e.getMessage();
            inventoryRepo.scheduleBootstrapRetry(instance.instancePk());
            stateRepo.updateLastError(instance.instancePk(), msg);

        } catch (Exception e) {
            log.error("Bootstrap hatasi: {} state={} — {}",
                    instance.instanceId(), state, e.getMessage(), e);
            String msg = state + " adiminda hata: " + e.getMessage();
            inventoryRepo.scheduleBootstrapRetry(instance.instancePk());
            stateRepo.updateLastError(instance.instancePk(), msg);
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
            // Discovery basarisiz — state discovering'de kalir, retry edilir.
            // Bu, daha once 'ready' olup connect/auth hatasi (orn. pg_hba.conf
            // erisiminin kaldirilmasi) yuzunden degraded'a dusup buraya geri
            // donen instance'lari da kapsar: BootstrapHandler.processBootstrapStep
            // degraded'i otomatik olarak pending -> discovering'e cekiyor, ve
            // discovery burada tekrar basarisiz olursa instance sessizce
            // 'discovering' state'inde donup durabiliyordu — hicbir alert
            // acilmiyordu (P0-024 sadece steady-state ready->degraded gecisini
            // kapsiyordu). Burada da SYSTEM_INSTANCE_UNREACHABLE aciyoruz ki
            // discovery tekrar basarisiz oldukca alert acik kalsin/guncellensin.
            log.warn("Discovery basarisiz, retry edilecek: {}", instance.instanceId());
            raiseUnreachableAlert(instance, stateRepo.getLastError(instance.instancePk()));
            return;
        }

        // pg_stat_statements yoksa degraded'a gec (temel ozelligi eksik)
        if (!cap.hasPgStatStatements()) {
            log.warn("pg_stat_statements bulunamadi, degraded: {}", instance.instanceId());
            inventoryRepo.scheduleBootstrapRetry(instance.instancePk());
            return;
        }

        inventoryRepo.updateBootstrapState(instance.instancePk(), "baselining");
        log.info("Discovery tamamlandi, baselining'e geciliyor: {}", instance.instanceId());
    }

    private void raiseUnreachableAlert(InstanceInfo instance, String errorDetail) {
        String alertKey = "system.instance_unreachable:instance=" + instance.instancePk();
        String details = new AlertDetailsBuilder()
            .setKind("system_health")
            .addContext("instance_pk", instance.instancePk())
            .addContext("instance_id", instance.instanceId())
            .addContext("reason", "discovery_failed")
            .addContext("last_error", errorDetail)
            .build();
        try {
            alertService.upsertSystemAlert(
                AlertCode.SYSTEM_INSTANCE_UNREACHABLE.getCode(),
                alertKey,
                AlertCode.SYSTEM_INSTANCE_UNREACHABLE.getDefaultSeverity(),
                instance.instancePk(),
                "Instance unreachable",
                "Discovery failed — pg_hba.conf access may have been revoked, or an "
                    + "authentication failure occurred. See error detail below.",
                details
            );
        } catch (Exception e) {
            log.error("SYSTEM_INSTANCE_UNREACHABLE alert acilamadi: {} — {}",
                instance.instanceId(), e.getMessage());
        }
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

        // Instance daha once (steady-state'te) connect/auth hatasi yuzunden degraded'a
        // dusup buraya geri donmusse, JobOrchestrator.handleSecretOrAuthError'da acilan
        // SYSTEM_INSTANCE_UNREACHABLE alert'ini burada kapatiyoruz (P0-024).
        try {
            alertService.resolveSystemAlert(
                "system.instance_unreachable:instance=" + instance.instancePk());
        } catch (Exception ignore) {}
    }
}
