package com.pgstat.collector.scheduler;

import com.pgstat.collector.collector.*;
import com.pgstat.collector.config.CollectorProperties;
import com.pgstat.collector.model.AlertCode;
import com.pgstat.collector.model.DbObjectsTarget;
import com.pgstat.collector.model.InstanceInfo;
import com.pgstat.collector.repository.*;
import com.pgstat.collector.service.AlertService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.concurrent.Semaphore;

/**
 * Tek @Scheduled poll loop ile 4 job type'i yoneten orkestrator.
 *
 * Her poll'da sirasi ile:
 *  1. Bootstrap queue (pending/discovering/baselining/enriching instance'lar)
 *  2. Cluster job (due instance'lar icin cluster metrikleri)
 *  3. Statements job (due instance'lar icin pg_stat_statements delta)
 *  4. DbObjects job (due database'ler icin tablo/index istatistikleri)
 *  5. Rollup job (saatlik + gunluk rollup, partition olusturma)
 *
 * Advisory lock ile ayni job type'in cakisan kopyalari engellenir.
 * CompletableFuture + Semaphore ile paralel host isleme yapilir.
 */
@Component
public class JobOrchestrator {

    private static final Logger log = LoggerFactory.getLogger(JobOrchestrator.class);

    private final AdvisoryLockManager lockManager;
    private final CollectorProperties props;
    private final Executor collectorExecutor;

    // Collector'lar
    private final BootstrapHandler bootstrapHandler;
    private final ClusterCollector clusterCollector;
    private final StatementsCollector statementsCollector;
    private final DbObjectsCollector dbObjectsCollector;
    private final TextEnricher textEnricher;

    // Repository'ler
    private final InventoryRepository inventoryRepo;
    private final StateRepository stateRepo;
    private final OpsRepository opsRepo;
    private final AggRepository aggRepo;

    // Alert servisi
    private final AlertService alertService;
    private final com.pgstat.collector.service.AlertRuleEvaluator alertRuleEvaluator;
    private final com.pgstat.collector.service.BaselineCalculator baselineCalculator;

    // Partition ve purge (Phase 1J'de eklenecek)
    private final com.pgstat.collector.service.PartitionManager partitionManager;
    private final com.pgstat.collector.service.PurgeEvaluator purgeEvaluator;
    private final com.pgstat.collector.service.PgssResetTracker resetTracker;

    public JobOrchestrator(AdvisoryLockManager lockManager,
                           CollectorProperties props,
                           @Qualifier("collectorExecutor") Executor collectorExecutor,
                           BootstrapHandler bootstrapHandler,
                           ClusterCollector clusterCollector,
                           StatementsCollector statementsCollector,
                           DbObjectsCollector dbObjectsCollector,
                           TextEnricher textEnricher,
                           InventoryRepository inventoryRepo,
                           StateRepository stateRepo,
                           OpsRepository opsRepo,
                           AggRepository aggRepo,
                           AlertService alertService,
                           com.pgstat.collector.service.AlertRuleEvaluator alertRuleEvaluator,
                           com.pgstat.collector.service.BaselineCalculator baselineCalculator,
                           com.pgstat.collector.service.PartitionManager partitionManager,
                           com.pgstat.collector.service.PurgeEvaluator purgeEvaluator,
                           com.pgstat.collector.service.PgssResetTracker resetTracker) {
        this.lockManager = lockManager;
        this.props = props;
        this.collectorExecutor = collectorExecutor;
        this.bootstrapHandler = bootstrapHandler;
        this.clusterCollector = clusterCollector;
        this.statementsCollector = statementsCollector;
        this.dbObjectsCollector = dbObjectsCollector;
        this.textEnricher = textEnricher;
        this.inventoryRepo = inventoryRepo;
        this.stateRepo = stateRepo;
        this.opsRepo = opsRepo;
        this.aggRepo = aggRepo;
        this.alertService = alertService;
        this.alertRuleEvaluator = alertRuleEvaluator;
        this.baselineCalculator = baselineCalculator;
        this.partitionManager = partitionManager;
        this.purgeEvaluator = purgeEvaluator;
        this.resetTracker = resetTracker;
    }

    /**
     * Ana poll loop — fixedDelay=5000ms ile calisir.
     * Her cycle'da bootstrap + 4 job type sirali isler.
     */
    @Scheduled(fixedDelayString = "${pgstat.worker.poll-interval-ms:5000}")
    public void poll() {
        // Pre-reset snapshot: pattern tespit edilen instance'lar icin
        // reset'ten 30sn once ekstra statements snapshot al
        try {
            List<Long> preResetInstances = resetTracker.findInstancesNeedingPreResetSnapshot();
            if (!preResetInstances.isEmpty()) {
                log.info("Pre-reset snapshot tetikleniyor: {} instance", preResetInstances.size());
                for (Long pk : preResetInstances) {
                    try {
                        InstanceInfo inst = inventoryRepo.findByPk(pk);
                        if (inst != null) {
                            statementsCollector.collect(inst);
                            log.info("Pre-reset snapshot tamamlandi instance={}", pk);
                        }
                    } catch (Exception e) {
                        log.warn("Pre-reset snapshot hatasi instance={}: {}", pk, e.getMessage());
                    }
                }
            }
        } catch (Exception e) {
            log.debug("Pre-reset schedule kontrolu hatasi: {}", e.getMessage());
        }

        processBootstrapQueue();
        runJob("cluster", this::executeClusterJob);
        runJob("statements", this::executeStatementsJob);
        runJob("db_objects", this::executeDbObjectsJob);
        runJob("rollup", this::executeRollupJob);

        // Manuel baseline tetikleri (UI'dan "Hemen Hesapla" butonu)
        try {
            baselineCalculator.processPendingTriggers();
        } catch (Exception e) {
            log.warn("Baseline trigger islemi hatasi: {}", e.getMessage());
        }
    }

    // =========================================================================
    // Bootstrap queue — advisory lock gerektirmez
    // =========================================================================

    private void processBootstrapQueue() {
        List<InstanceInfo> queue = inventoryRepo.findBootstrapQueue(props.getBootstrapBatchSize());
        if (queue.isEmpty()) return;

        log.info("Bootstrap queue: {} instance islenecek", queue.size());
        for (InstanceInfo instance : queue) {
            try {
                bootstrapHandler.processBootstrapStep(instance);
            } catch (Exception e) {
                log.error("Bootstrap hatasi: {} — {}", instance.instanceId(), e.getMessage());
            }
        }
    }

    // =========================================================================
    // Job calistirma altyapisi
    // =========================================================================

    /** Advisory lock alip job'i calistirir; lock alinamazsa atlar. */
    private void runJob(String jobType, Runnable jobAction) {
        try (AdvisoryLockManager.LockHandle lock = lockManager.tryAcquire(jobType)) {
            if (lock == null) {
                // Lock alinamadi — baska kopya calisiyor, sessizce atla
                java.util.Map<String, Object> ctx = new java.util.HashMap<>();
                ctx.put("job_type", jobType);
                ctx.put("skipped_at", java.time.Instant.now().toString());
                ctx.put("severity", "info");
                alertService.raiseJobAlert(AlertCode.ADVISORY_LOCK_SKIP, ctx,
                    "Advisory lock alinamadi: " + jobType,
                    jobType + " job'i icin lock alinamadi, baska kopya calisiyor olabilir");
                return;
            }
            jobAction.run();
        } catch (Exception e) {
            log.error("{} job hatasi: {}", jobType, e.getMessage(), e);
            java.util.Map<String, Object> ctx = new java.util.HashMap<>();
            ctx.put("job_type", jobType);
            ctx.put("error_message", e.getMessage());
            ctx.put("job_run_at", java.time.Instant.now().toString());
            ctx.put("severity", "error");
            alertService.raiseJobAlert(AlertCode.JOB_FAILED, ctx,
                jobType + " job basarisiz", e.getMessage());
        }
    }

    // =========================================================================
    // Cluster job
    // =========================================================================

    private void executeClusterJob() {
        List<InstanceInfo> dueInstances = inventoryRepo.findDueInstances(props.getSchedulerBatchSize());
        if (dueInstances.isEmpty()) return;

        long jobRunId = opsRepo.startJobRun("cluster", props.getHostname());
        Semaphore semaphore = new Semaphore(props.getMaxConcurrentHosts());
        List<CompletableFuture<InstanceResult>> futures = new ArrayList<>();

        for (InstanceInfo instance : dueInstances) {
            // Sadece cluster due olanlari isle
            if (instance.nextClusterCollectAt() != null
                    && instance.nextClusterCollectAt().isAfter(java.time.OffsetDateTime.now())) {
                continue;
            }

            futures.add(CompletableFuture.supplyAsync(() -> {
                try {
                    semaphore.acquire();
                    try {
                        return processClusterInstance(jobRunId, instance);
                    } finally {
                        semaphore.release();
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return new InstanceResult(instance.instancePk(), false, 0, e.getMessage());
                }
            }, collectorExecutor));
        }

        // Tum future'lari bekle ve sonuclari topla
        finishJob(jobRunId, "cluster", futures);
    }

    private InstanceResult processClusterInstance(long jobRunId, InstanceInfo instance) {
        long runInstanceId = opsRepo.startJobRunInstance(jobRunId, instance.instancePk(), "cluster");
        try {
            long rows = clusterCollector.collect(instance);

            // State guncelle — cluster toplandi, statements toplanmadi
            stateRepo.updateAfterSuccess(
                java.time.OffsetDateTime.now(), true, false,
                instance.clusterIntervalSeconds(),
                0, false, null, instance.instancePk()
            );

            opsRepo.finishJobRunInstance(runInstanceId, "success", rows, 0, 0, null);
            return new InstanceResult(instance.instancePk(), true, rows, null);

        } catch (Exception e) {
            log.error("Cluster toplama hatasi: {} — {}", instance.instanceId(), e.getMessage());
            stateRepo.updateAfterFailure(instance.instancePk(), truncate(e.getMessage()));
            opsRepo.finishJobRunInstance(runInstanceId, "failed", 0, 0, 0, truncate(e.getMessage()));

            handleSecretOrAuthError(instance, e);
            return new InstanceResult(instance.instancePk(), false, 0, e.getMessage());
        }
    }

    /**
     * Secret/auth hatasi → instance'i degraded'a cek, bootstrap retry baslat.
     * Steady-state queue artik bu instance'i cekmez (V035 sonrasi findDueInstances
     * sadece 'ready' aliyor) ve JOB_PARTIAL_FAILURE her cycle tekrar tetiklenmez.
     * SECRET_REF_ERROR alert'i bootstrap'tan zaten gelir.
     */
    private void handleSecretOrAuthError(InstanceInfo instance, Exception e) {
        String em = e.getMessage() != null ? e.getMessage().toLowerCase() : "";
        if (em.contains("secret_ref") || em.contains("authentication") || em.contains("password")
                || em.contains("connect")) {
            try {
                inventoryRepo.scheduleBootstrapRetry(instance.instancePk());
                log.info("Instance degraded'a cekildi (secret/auth/connect hatasi): {}",
                    instance.instanceId());
            } catch (Exception ignore) {}
        }
    }

    // =========================================================================
    // Statements job
    // =========================================================================

    private void executeStatementsJob() {
        List<InstanceInfo> dueInstances = inventoryRepo.findDueInstances(props.getSchedulerBatchSize());
        if (dueInstances.isEmpty()) return;

        long jobRunId = opsRepo.startJobRun("statements", props.getHostname());
        Semaphore semaphore = new Semaphore(props.getMaxConcurrentHosts());
        List<CompletableFuture<InstanceResult>> futures = new ArrayList<>();

        for (InstanceInfo instance : dueInstances) {
            // Sadece statements due olanlari isle
            if (instance.nextStatementsCollectAt() != null
                    && instance.nextStatementsCollectAt().isAfter(java.time.OffsetDateTime.now())) {
                continue;
            }

            futures.add(CompletableFuture.supplyAsync(() -> {
                try {
                    semaphore.acquire();
                    try {
                        return processStatementsInstance(jobRunId, instance);
                    } finally {
                        semaphore.release();
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return new InstanceResult(instance.instancePk(), false, 0, e.getMessage());
                }
            }, collectorExecutor));
        }

        finishJob(jobRunId, "statements", futures);
    }

    private InstanceResult processStatementsInstance(long jobRunId, InstanceInfo instance) {
        long runInstanceId = opsRepo.startJobRunInstance(jobRunId, instance.instancePk(), "statements");
        try {
            StatementsCollector.CollectResult result = statementsCollector.collect(instance);

            // Text enrichment — statements toplama sonrasi
            int textCount = 0;
            try {
                textCount = textEnricher.enrich(instance, instance.bootstrapSqlTextBatch());
            } catch (Exception e) {
                log.warn("Text enrichment hatasi: {} — {}", instance.instanceId(), e.getMessage());
            }

            // State guncelle — statements toplandi
            stateRepo.updateAfterSuccess(
                java.time.OffsetDateTime.now(), false, true,
                0, instance.statementsIntervalSeconds(),
                false, result.epochKey(), instance.instancePk()
            );

            opsRepo.finishJobRunInstance(runInstanceId, "success",
                result.rowsWritten(), result.newSeriesCount(), textCount, null);
            return new InstanceResult(instance.instancePk(), true, result.rowsWritten(), null);

        } catch (Exception e) {
            log.error("Statements toplama hatasi: {} — {}", instance.instanceId(), e.getMessage());
            stateRepo.updateAfterFailure(instance.instancePk(), truncate(e.getMessage()));
            opsRepo.finishJobRunInstance(runInstanceId, "failed", 0, 0, 0, truncate(e.getMessage()));
            handleSecretOrAuthError(instance, e);
            return new InstanceResult(instance.instancePk(), false, 0, e.getMessage());
        }
    }

    // =========================================================================
    // DbObjects job
    // =========================================================================

    private void executeDbObjectsJob() {
        List<DbObjectsTarget> dueTargets = inventoryRepo.findDueDbObjects(props.getSchedulerBatchSize());
        if (dueTargets.isEmpty()) return;

        long jobRunId = opsRepo.startJobRun("db_objects", props.getHostname());
        Semaphore semaphore = new Semaphore(props.getMaxConcurrentHosts());
        List<CompletableFuture<InstanceResult>> futures = new ArrayList<>();

        for (DbObjectsTarget target : dueTargets) {
            futures.add(CompletableFuture.supplyAsync(() -> {
                try {
                    semaphore.acquire();
                    try {
                        return processDbObjectsTarget(jobRunId, target);
                    } finally {
                        semaphore.release();
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return new InstanceResult(target.instancePk(), false, 0, e.getMessage());
                }
            }, collectorExecutor));
        }

        finishJob(jobRunId, "db_objects", futures);
    }

    private InstanceResult processDbObjectsTarget(long jobRunId, DbObjectsTarget target) {
        long runInstanceId = opsRepo.startJobRunInstance(jobRunId, target.instancePk(), "db_objects");
        try {
            long rows = dbObjectsCollector.collect(target);

            stateRepo.updateDatabaseStateAfterSuccess(
                target.instancePk(), target.dbid(), target.dbObjectsIntervalSeconds());

            opsRepo.finishJobRunInstance(runInstanceId, "success", rows, 0, 0, null);
            return new InstanceResult(target.instancePk(), true, rows, null);

        } catch (Exception e) {
            log.error("DbObjects toplama hatasi: {}:{} — {}",
                target.instanceId(), target.datname(), e.getMessage());
            stateRepo.updateDatabaseStateAfterFailure(target.instancePk(), target.dbid());
            opsRepo.finishJobRunInstance(runInstanceId, "failed", 0, 0, 0, truncate(e.getMessage()));

            // Secret/auth hatasi → instance'i degraded'a cek
            String em = e.getMessage() != null ? e.getMessage().toLowerCase() : "";
            if (em.contains("secret_ref") || em.contains("authentication") || em.contains("password")
                    || em.contains("connect")) {
                try {
                    inventoryRepo.scheduleBootstrapRetry(target.instancePk());
                    log.info("Instance degraded'a cekildi (secret/auth/connect, db_objects job): pk={}",
                        target.instancePk());
                } catch (Exception ignore) {}
            }
            return new InstanceResult(target.instancePk(), false, 0, e.getMessage());
        }
    }

    // =========================================================================
    // Rollup job
    // =========================================================================

    private void executeRollupJob() {
        long jobRunId = opsRepo.startJobRun("rollup", props.getHostname());
        long totalRows = 0;
        String status = "success";
        String errorText = null;

        try {
            // 1. Partition olusturma (gelecek gunler icin)
            partitionManager.ensureFuturePartitions();

            // 2. Saatlik rollup
            int hourlyRows = aggRepo.rollupHourly();
            totalRows += hourlyRows;
            log.info("Saatlik rollup tamamlandi: {} satir", hourlyRows);

            // 3. Gunluk rollup — sadece UTC saat eslesirse
            int dailyRollupHour = 1; // default
            int currentUtcHour = java.time.OffsetDateTime.now(java.time.ZoneOffset.UTC).getHour();
            if (currentUtcHour == dailyRollupHour) {
                int dailyRows = aggRepo.rollupDaily();
                totalRows += dailyRows;
                log.info("Gunluk rollup tamamlandi: {} satir", dailyRows);

                // 3b. Adaptive baseline — gunde 1 kez, daily rollup ile ayni pencerede
                try {
                    baselineCalculator.calculateAll();
                } catch (Exception e) {
                    log.warn("Baseline hesaplamasi hatasi: {}", e.getMessage());
                }
            }

            // 4. Alert kurallarini degerlendir
            alertRuleEvaluator.evaluate();

            // 5. Purge evaluator — retention temizligi
            purgeEvaluator.evaluate();

            // 6. State guncelle
            stateRepo.updateRollupTimestamp();

        } catch (Exception e) {
            log.error("Rollup job hatasi: {}", e.getMessage(), e);
            status = "failed";
            errorText = truncate(e.getMessage());
            java.util.Map<String, Object> ctx = new java.util.HashMap<>();
            ctx.put("job_type", "rollup");
            ctx.put("error_message", e.getMessage());
            ctx.put("job_run_at", java.time.Instant.now().toString());
            ctx.put("severity", "error");
            alertService.raiseJobAlert(AlertCode.JOB_FAILED, ctx,
                "Rollup job basarisiz", e.getMessage());
        }

        opsRepo.finishJobRun(jobRunId, status, totalRows, 0, 0, errorText);
    }

    // =========================================================================
    // Yardimci metotlar
    // =========================================================================

    /** Tum future'lari bekle, sonuclari topla ve job_run'i bitir. */
    private void finishJob(long jobRunId, String jobType,
                           List<CompletableFuture<InstanceResult>> futures) {
        // Tum future'lari bekle
        CompletableFuture.allOf(futures.toArray(new CompletableFuture[0])).join();

        long totalRows = 0;
        int succeeded = 0;
        int failed = 0;
        StringBuilder errors = new StringBuilder();

        for (CompletableFuture<InstanceResult> f : futures) {
            try {
                InstanceResult r = f.get();
                totalRows += r.rowsWritten;
                if (r.success) {
                    succeeded++;
                } else {
                    failed++;
                    if (r.error != null) {
                        if (errors.length() > 0) errors.append("; ");
                        errors.append("pk=").append(r.instancePk).append(": ").append(r.error);
                    }
                }
            } catch (Exception e) {
                failed++;
            }
        }

        String status = failed == 0 ? "success" : (succeeded > 0 ? "partial" : "failed");
        String errorText = errors.length() > 0 ? truncate(errors.toString()) : null;

        opsRepo.finishJobRun(jobRunId, status, totalRows, succeeded, failed, errorText);

        if (failed > 0) {
            AlertCode code = failed == futures.size() ? AlertCode.JOB_FAILED : AlertCode.JOB_PARTIAL_FAILURE;
            java.util.Map<String, Object> ctx = new java.util.HashMap<>();
            ctx.put("job_type", jobType);
            ctx.put("failed_count", failed);
            ctx.put("total_count", succeeded + failed);
            ctx.put("succeeded_count", succeeded);
            ctx.put("error_message", errorText != null ? errorText : "—");
            ctx.put("failed_instances", errorText != null ? errorText : "—");
            ctx.put("job_run_at", java.time.Instant.now().toString());
            ctx.put("severity", code == AlertCode.JOB_FAILED ? "error" : "warning");
            alertService.raiseJobAlert(code, ctx,
                jobType + " job: " + failed + "/" + (succeeded + failed) + " basarisiz",
                errorText);
        }

        log.info("{} job tamamlandi: {} basarili, {} basarisiz, {} satir",
            jobType, succeeded, failed, totalRows);
    }

    /** Hata mesajini 1000 karaktere kisalt. */
    private String truncate(String text) {
        if (text == null) return null;
        return text.length() > 1000 ? text.substring(0, 1000) : text;
    }

    /** Instance bazli sonuc. */
    private record InstanceResult(long instancePk, boolean success, long rowsWritten, String error) {}
}
