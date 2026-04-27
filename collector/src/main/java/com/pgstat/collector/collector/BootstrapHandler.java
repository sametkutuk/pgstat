package com.pgstat.collector.collector;

import com.pgstat.collector.model.AlertCode;
import com.pgstat.collector.model.InstanceCapability;
import com.pgstat.collector.model.InstanceInfo;
import com.pgstat.collector.repository.AlertRepository;
import com.pgstat.collector.repository.InventoryRepository;
import com.pgstat.collector.repository.StateRepository;
import com.pgstat.collector.service.AlertMessageRenderer;
import com.pgstat.collector.service.SecretResolver;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.HashMap;
import java.util.Map;

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
    private final StateRepository stateRepo;
    private final AlertMessageRenderer renderer;

    public BootstrapHandler(DiscoveryCollector discoveryCollector,
                            InventoryRepository inventoryRepo,
                            AlertRepository alertRepo,
                            StateRepository stateRepo,
                            AlertMessageRenderer renderer) {
        this.discoveryCollector = discoveryCollector;
        this.inventoryRepo = inventoryRepo;
        this.alertRepo = alertRepo;
        this.stateRepo = stateRepo;
        this.renderer = renderer;
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
            Map<String, Object> ctx = baseCtx(instance);
            ctx.put("error_message", e.getMessage());
            ctx.put("secret_ref", e.getMessage());
            raiseAlert(instance, AlertCode.SECRET_REF_ERROR, ctx,
                    "Secret cozumleme hatasi: " + instance.instanceId(), msg);
            inventoryRepo.scheduleBootstrapRetry(instance.instancePk());
            stateRepo.updateLastError(instance.instancePk(), msg);

        } catch (Exception e) {
            log.error("Bootstrap hatasi: {} state={} — {}",
                    instance.instanceId(), state, e.getMessage(), e);
            String msg = state + " adiminda hata: " + e.getMessage();
            Map<String, Object> ctx = baseCtx(instance);
            ctx.put("phase", state);
            ctx.put("error_message", e.getMessage());
            raiseAlert(instance, AlertCode.BOOTSTRAP_FAILED, ctx,
                    "Bootstrap basarisiz: " + instance.instanceId(), msg);
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
            // Discovery basarisiz — state discovering'de kalir, retry edilir
            log.warn("Discovery basarisiz, retry edilecek: {}", instance.instanceId());
            return;
        }

        // pg_stat_statements yoksa degraded'a gec (temel ozelligi eksik)
        if (!cap.hasPgStatStatements()) {
            log.warn("pg_stat_statements bulunamadi, degraded: {}", instance.instanceId());
            Map<String, Object> ctx = baseCtx(instance);
            raiseAlert(instance, AlertCode.EXTENSION_MISSING, ctx,
                    "Extension eksik: " + instance.instanceId(),
                    "pg_stat_statements extension'i bulunamadi");
            inventoryRepo.scheduleBootstrapRetry(instance.instancePk());
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

    /**
     * Renderer ile sablon uygular, sonra upsert eder.
     * Sablon yoksa ya da render hata verirse fallback metinleri kullanir.
     */
    private void raiseAlert(InstanceInfo instance, AlertCode code,
                            Map<String, Object> ctx,
                            String fallbackTitle, String fallbackMessage) {
        String alertKey = code.getCode() + ":" + code.getSourceComponent()
                + ":" + instance.instancePk();
        String title = fallbackTitle;
        String message = fallbackMessage;
        try {
            String[] rendered = renderer.renderForCode(code.getCode(), ctx,
                    fallbackTitle, fallbackMessage);
            title = rendered[0];
            message = rendered[1];
        } catch (Exception e) {
            log.debug("Alert template render hatasi code={}: {}", code.getCode(), e.getMessage());
        }
        alertRepo.upsert(alertKey, code, instance.instancePk(),
                null, null, title, message, null);
    }

    /** Tum alert'ler icin ortak instance context'i. */
    private Map<String, Object> baseCtx(InstanceInfo instance) {
        Map<String, Object> ctx = new HashMap<>();
        ctx.put("instance", instance.instanceId());
        ctx.put("instance_pk", instance.instancePk());
        ctx.put("host", instance.host());
        ctx.put("port", instance.port());
        return ctx;
    }
}
