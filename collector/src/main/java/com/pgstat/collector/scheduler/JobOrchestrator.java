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
    private static final long STARTUP_GRACE_MS = 30_000L;

    private final AdvisoryLockManager lockManager;
    private final CollectorProperties props;
    private final Executor collectorExecutor;
    private final long startedAtMs = System.currentTimeMillis();

    // Collector'lar
    private final BootstrapHandler bootstrapHandler;
    private final com.pgstat.collector.collector.DiscoveryCollector discoveryCollector;
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

    // Gece snapshot + aksiyon-odakli alert'ler
    private final com.pgstat.collector.collector.NightlySnapshotCollector nightlySnapshotCollector;
    private final org.springframework.jdbc.core.JdbcTemplate jdbc;
    private final com.pgstat.collector.service.ReportGenerator reportGenerator;
    private final com.pgstat.collector.service.WorkloadClassifier workloadClassifier;
    private final com.pgstat.collector.service.SystemHealthEvaluator systemHealthEvaluator;
    private final com.pgstat.collector.service.XidFreezeEvaluator xidFreezeEvaluator;

    // Acute alert dispatch frekansi — son tetikleme zamani.

    // Rolling alert evaluation — 15 dakikada bir (temp files, idle in tx, inactive slot)
    // Her 5 saniyede calistirmak gereksiz yuk, 15dk yeterli.

    // Saat-bazli job idempotency — saat eslesmesi 1 saat surdugu icin her 5s'de
    // tekrar tetiklenmesin diye gun bazinda guard tutuyoruz. UTC saatleri:
    //   01:00 → daily rollup + baseline
    //   02:00 → job_run history purge
    //   03:00 → nightly PG snapshot
    //   06:00 → daily report (Pazartesi haftalik da)
    // In-memory state — restart'ta resetlenir; o saat icinde restart olursa
    // bir kerelik dup olabilir, bu kabul edilebilir.
    private volatile java.time.LocalDate lastDailyRollupDate = null;
    private volatile java.time.LocalDate lastJobPurgeDate = null;
    private volatile java.time.LocalDate lastNightlySnapshotDate = null;
    private volatile java.time.LocalDate lastDailyReportDate = null;
    private volatile java.time.LocalDate lastWeeklyReportDate = null;
    // Hot settings refresh: 3 saatte bir, en son tetikleme saati izlenir
    private volatile int lastHotSettingsHourUtc = -1;
    // Freeze/settings snapshot: 6 saatte bir (XID freeze izleme gun ici resolve icin)
    private volatile int lastFreezeSnapshotHourUtc = -1;
    // Saatlik rollup: son calisma zamani (ms). schedule_profile.hourly_rollup_interval_seconds
    // ile sinirlanir. Eskiden her poll'da (5sn) calisiyordu -> dakikada ~9 kez,
    // gereksiz agg yeniden-yazma + yuksek central DB TPS. Interval guard ile seyreltildi.
    private volatile long lastHourlyRollupAtMs = 0L;
    // Per-table freeze: instance bazli son toplama zamani
    private final java.util.Map<Long, Long> lastTableFreezeMillisByInstance =
        new java.util.concurrent.ConcurrentHashMap<>();
    // Periyodik database re-discovery: ready instance'larda sonradan eklenen
    // database'leri yakalamak icin (discovery normalde sadece bootstrap'ta calisir).
    private volatile long lastRediscoveryAtMs = 0L;
    private static final long REDISCOVERY_INTERVAL_MS = 3600_000L; // saatte bir

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
                           com.pgstat.collector.service.PgssResetTracker resetTracker,
                           com.pgstat.collector.collector.NightlySnapshotCollector nightlySnapshotCollector,
                           org.springframework.jdbc.core.JdbcTemplate jdbc,
                           com.pgstat.collector.service.ReportGenerator reportGenerator,
                           com.pgstat.collector.service.WorkloadClassifier workloadClassifier,
                           com.pgstat.collector.service.SystemHealthEvaluator systemHealthEvaluator,
                           com.pgstat.collector.service.XidFreezeEvaluator xidFreezeEvaluator,
                           com.pgstat.collector.collector.DiscoveryCollector discoveryCollector) {
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
        this.nightlySnapshotCollector = nightlySnapshotCollector;
        this.jdbc = jdbc;
        this.reportGenerator = reportGenerator;
        this.workloadClassifier = workloadClassifier;
        this.systemHealthEvaluator = systemHealthEvaluator;
        this.xidFreezeEvaluator = xidFreezeEvaluator;
        this.discoveryCollector = discoveryCollector;
    }

    /**
     * Ana poll loop — fixedDelay=5000ms ile calisir.
     * Her cycle'da bootstrap + 4 job type sirali isler.
     */
    @Scheduled(fixedDelayString = "${pgstat.worker.poll-interval-ms:5000}")
    public void poll() {
        long uptimeMs = System.currentTimeMillis() - startedAtMs;
        if (uptimeMs < STARTUP_GRACE_MS) {
            log.debug("Startup grace aktif, poll atlandi: kalanMs={}", STARTUP_GRACE_MS - uptimeMs);
            return;
        }

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
        runJob("rediscovery", this::executeRediscoveryJob);

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

    /**
     * Periyodik database re-discovery (saatte bir). Discovery normalde SADECE
     * bootstrap'ta calisir; instance 'ready' olduktan sonra eklenen database'ler
     * (orn yeni CREATE DATABASE) kesfedilmezdi. Bu job ready instance'larin
     * database listesini periyodik yeniler -> yeni DB'ler dim.database_ref'e girer,
     * db_objects job onlara baglanmaya baslar (ve erisilemiyorsa
     * database_inaccessible alerti tetiklenir).
     */
    private void executeRediscoveryJob() {
        long nowMs = System.currentTimeMillis();
        if (nowMs - lastRediscoveryAtMs < REDISCOVERY_INTERVAL_MS) return;
        lastRediscoveryAtMs = nowMs;

        List<InstanceInfo> ready = inventoryRepo.findAllReady();
        if (ready.isEmpty()) return;
        log.info("Rediscovery: {} ready instance icin database listesi yenileniyor", ready.size());
        for (InstanceInfo instance : ready) {
            try {
                discoveryCollector.rediscoverDatabases(instance);
            } catch (Exception e) {
                log.warn("Rediscovery hatasi: {} — {}", instance.instanceId(), e.getMessage());
            }
        }
    }

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
            alertService.raiseJobAlert(AlertCode.SYSTEM_CLEANUP_FAILED, ctx,
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
        // Manuel tetikleme: control.db_objects_trigger'da pending varsa o instance'in
        // TUM tablolarini interval'a bakmadan topla (Vacuum Lag "Simdi Topla" butonu).
        processManualDbObjectsTriggers();

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

    /**
     * control.db_objects_trigger'daki pending kayitlari isler: ilgili instance'in
     * TUM tablolarini hemen toplar (interval'a bakmaz). Vacuum sonrasi UI'dan
     * "Simdi Topla" ile tetiklenir. Her trigger ayri instance, sirayla islenir.
     */
    private void processManualDbObjectsTriggers() {
        List<Long> triggerIds;
        try {
            triggerIds = jdbc.queryForList(
                "select trigger_id from control.db_objects_trigger where status = 'pending' order by trigger_id",
                Long.class);
        } catch (Exception e) {
            // Tablo henuz yoksa (V079 uygulanmamis) sessizce gec
            return;
        }
        if (triggerIds.isEmpty()) return;

        for (Long triggerId : triggerIds) {
            Long instancePk;
            try {
                instancePk = jdbc.queryForObject(
                    "update control.db_objects_trigger set status = 'running', started_at = now() " +
                    "where trigger_id = ? and status = 'pending' returning instance_pk",
                    Long.class, triggerId);
            } catch (Exception e) {
                continue; // baska worker almis olabilir
            }
            if (instancePk == null) continue;

            try {
                List<DbObjectsTarget> targets = inventoryRepo.findDbObjectsByInstance(instancePk);
                if (targets.isEmpty()) {
                    jdbc.update("update control.db_objects_trigger set status = 'done', finished_at = now(), rows_written = 0 where trigger_id = ?", triggerId);
                    continue;
                }
                long jobRunId = opsRepo.startJobRun("db_objects_manual", props.getHostname());
                long totalRows = 0;
                int succeeded = 0;
                int failed = 0;
                for (DbObjectsTarget target : targets) {
                    try {
                        InstanceResult r = processDbObjectsTarget(jobRunId, target);
                        totalRows += r.rowsWritten();
                        if (r.success()) succeeded++; else failed++;
                    } catch (Exception e) {
                        failed++;
                        log.warn("Manuel db_objects hatasi instance={} db={}: {}",
                            instancePk, target.datname(), e.getMessage());
                    }
                }
                opsRepo.finishJobRun(jobRunId, failed > 0 ? "partial" : "success", totalRows, succeeded, failed, null);
                jdbc.update("update control.db_objects_trigger set status = 'done', finished_at = now(), rows_written = ? where trigger_id = ?",
                    totalRows, triggerId);
                log.info("Manuel db_objects toplama tamamlandi: instance_pk={}, {} db, {} satir",
                    instancePk, targets.size(), totalRows);
            } catch (Exception e) {
                log.warn("Manuel db_objects trigger hatasi trigger_id={}: {}", triggerId, e.getMessage());
                jdbc.update("update control.db_objects_trigger set status = 'failed', finished_at = now() where trigger_id = ?", triggerId);
            }
        }
    }

    private InstanceResult processDbObjectsTarget(long jobRunId, DbObjectsTarget target) {
        long runInstanceId = opsRepo.startJobRunInstance(jobRunId, target.instancePk(), "db_objects");
        try {
            long rows = dbObjectsCollector.collect(target);

            stateRepo.updateDatabaseStateAfterSuccess(
                target.instancePk(), target.dbid(), target.dbObjectsIntervalSeconds());

            // Bu DB'ye basariyla baglanildi -> varsa 'erisilemez' alertini cozumle.
            alertService.resolveDatabaseAlert(
                AlertCode.DATABASE_INACCESSIBLE, target.instancePk(), target.dbid());

            opsRepo.finishJobRunInstance(runInstanceId, "success", rows, 0, 0, null);
            return new InstanceResult(target.instancePk(), true, rows, null);

        } catch (Exception e) {
            log.error("DbObjects toplama hatasi: {}:{} — {}",
                target.instanceId(), target.datname(), e.getMessage());
            stateRepo.updateDatabaseStateAfterFailure(target.instancePk(), target.dbid());
            opsRepo.finishJobRunInstance(runInstanceId, "failed", 0, 0, 0, truncate(e.getMessage()));

            // CONNECT/yetki reddi mi? -> o DB izlenemiyor (kor nokta), alert uret.
            // Bu, instance genelinde bir sorun DEGIL: tek bir database'e pgstat'in
            // CONNECT yetkisi yok. Bu yuzden instance'i degraded'a CEKMEYIZ; sadece
            // ilgili database icin alert acariz. Erisim verilince basari dalinda resolve olur.
            // Kullanici ayarlari (control.database_access_subscription): enabled mi,
            // kac ardisik basarisizliktan sonra, hangi severity, bildirim gitsin mi.
            if (isDatabaseAccessDenied(e)) {
                DatabaseAccessConfig cfg = loadDatabaseAccessConfig(target.instancePk());
                if (cfg.enabled()) {
                    // consecutive_failures az once updateDatabaseStateAfterFailure ile +1 oldu.
                    int fails = readConsecutiveFailures(target.instancePk(), target.dbid());
                    if (fails >= cfg.failThreshold()) {
                        String title = "Database izlenemiyor: " + target.datname();
                        String message = "pgstat '" + target.datname() + "' database'ine CONNECT edemiyor "
                            + "(yetki yok, " + fails + " ardisik basarisiz). Bu database izlenmiyor. "
                            + "Cozum: collector kullanicisina "
                            + "GRANT CONNECT ON DATABASE " + target.datname() + " TO <collector_user>; verin. "
                            + "Hata: " + truncate(e.getMessage());
                        alertService.raiseDatabaseAlert(
                            AlertCode.DATABASE_INACCESSIBLE, target.instancePk(), target.dbid(),
                            cfg.severity(), cfg.notifySend(), title, message, null);
                    } else {
                        log.debug("database_inaccessible esik altinda ({}/{}), alert yok: {}:{}",
                            fails, cfg.failThreshold(), target.instanceId(), target.datname());
                    }
                }
                return new InstanceResult(target.instancePk(), false, 0, e.getMessage());
            }

            // Diger secret/auth/network hatasi → instance'i degraded'a cek
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

    /**
     * Hata, belirli bir database'e CONNECT yetkisinin OLMAMASINDAN mi kaynaklaniyor?
     * PostgreSQL: SQLState 42501 (insufficient_privilege) veya mesajda
     * "permission denied for database". Bunu network/auth hatalarindan ayirir ki
     * sadece gercek yetki reddinde 'database_inaccessible' alerti acilsin.
     */
    private boolean isDatabaseAccessDenied(Exception e) {
        Throwable cur = e;
        while (cur != null) {
            if (cur instanceof java.sql.SQLException sqlEx) {
                String state = sqlEx.getSQLState();
                if ("42501".equals(state)) return true;
            }
            String msg = cur.getMessage();
            if (msg != null) {
                String lower = msg.toLowerCase();
                if (lower.contains("permission denied for database")) return true;
            }
            cur = cur.getCause();
        }
        return false;
    }

    /** database_inaccessible alert kullanici ayarlari (per-instance). */
    private record DatabaseAccessConfig(boolean enabled, int failThreshold, String severity, boolean notifySend) {}

    /**
     * control.database_access_subscription'tan instance ayarlarini okur.
     * Satir yoksa (eski/yeni instance) guvenli varsayilan: enabled, esik=2,
     * warning, bildirim acik.
     */
    private DatabaseAccessConfig loadDatabaseAccessConfig(long instancePk) {
        try {
            return jdbc.queryForObject("""
                select is_enabled, fail_threshold, severity, notify_on_inaccessible
                from control.database_access_subscription
                where instance_pk = ?
                """,
                (rs, n) -> new DatabaseAccessConfig(
                    rs.getBoolean("is_enabled"),
                    rs.getInt("fail_threshold"),
                    rs.getString("severity"),
                    rs.getBoolean("notify_on_inaccessible")
                ),
                instancePk);
        } catch (Exception e) {
            // Satir yok veya hata -> varsayilan (enabled, esik 2, warning, bildir).
            return new DatabaseAccessConfig(true, 2, "warning", true);
        }
    }

    /** control.database_state.consecutive_failures (per-DB) degerini okur. */
    private int readConsecutiveFailures(long instancePk, long dbid) {
        try {
            Integer v = jdbc.queryForObject(
                "select consecutive_failures from control.database_state where instance_pk = ? and dbid = ?",
                Integer.class, instancePk, dbid);
            return v != null ? v : 1;
        } catch (Exception e) {
            return 1;
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
            // 1. Partition olusturma (gelecek gunler icin) — HER cycle calisir
            //    (partition eksikligi kritik, ucuz islem).
            partitionManager.ensureFuturePartitions();

            // 2. Saatlik rollup — INTERVAL GUARD'li. Eskiden her poll'da (5sn)
            //    calisiyordu: dakikada ~9 kez ayni saatlik bucket'i yeniden yaziyordu
            //    (ON CONFLICT DO UPDATE), gereksiz central DB TPS. Artik
            //    schedule_profile.hourly_rollup_interval_seconds (en kisa aktif profil,
            //    default 300sn) gecmeden atlanir.
            long nowMs = System.currentTimeMillis();
            int rollupIntervalSec = readHourlyRollupIntervalSec();
            if (nowMs - lastHourlyRollupAtMs >= rollupIntervalSec * 1000L) {
                lastHourlyRollupAtMs = nowMs;

                int hourlyRows = aggRepo.rollupHourly();
                totalRows += hourlyRows;
                log.info("Saatlik rollup tamamlandi: {} satir", hourlyRows);

                int tableStatHourlyRows = aggRepo.rollupTableStatHourly();
                totalRows += tableStatHourlyRows;
                log.info("Table stat saatlik rollup tamamlandi: {} satir", tableStatHourlyRows);

                int walHourlyRows = aggRepo.rollupWalHourly();
                totalRows += walHourlyRows;
                log.info("WAL saatlik rollup tamamlandi: {} satir", walHourlyRows);
            }

            // 3. Gunluk rollup — sadece UTC saat eslesirse, gunde 1 kez (idempotency guard)
            int dailyRollupHour = 1; // default
            int currentUtcHour = java.time.OffsetDateTime.now(java.time.ZoneOffset.UTC).getHour();
            java.time.LocalDate todayUtc = java.time.LocalDate.now(java.time.ZoneOffset.UTC);
            if (currentUtcHour == dailyRollupHour && !todayUtc.equals(lastDailyRollupDate)) {
                lastDailyRollupDate = todayUtc;
                try {
                    int dailyRows = aggRepo.rollupDaily();
                    totalRows += dailyRows;
                    log.info("Gunluk rollup tamamlandi: {} satir", dailyRows);

                    // 3b. Adaptive baseline — gunde 1 kez, daily rollup ile ayni pencerede
                    try {
                        baselineCalculator.calculateAll();
                    } catch (Exception e) {
                        log.warn("Baseline hesaplamasi hatasi: {}", e.getMessage());
                    }
                } catch (Exception e) {
                    log.warn("Gunluk rollup hatasi: {}", e.getMessage());
                    lastDailyRollupDate = null; // hata varsa bir sonraki cycle tekrar dene
                }
            }

            // 3c. Daily cleanup — UTC saat 2'de gunde 1 kez (idempotency guard).
            // AGIR is (snapshot rollup dakikalar surebilir) -> AYRI THREAD'de calistir
            // ki poll loop bloklanmasin (eskiden senkrondu: 28-43dk poll donuyor,
            // collector_stale alert + DB time spike olusuyordu). Guard senkron set edilir
            // (ayni gun tekrar tetiklenmesin); is asenkron, hata olursa guard geri alinir.
            if (currentUtcHour == 2 && !todayUtc.equals(lastJobPurgeDate)) {
                lastJobPurgeDate = todayUtc;
                final java.time.LocalDate purgeDate = todayUtc;
                collectorExecutor.execute(() -> {
                    try {
                        log.info("Gunluk bakim (purge + snapshot rollup) ayri thread'de basladi");
                        purgeEvaluator.purgeJobRunHistory();
                        purgeEvaluator.purgeReportsAndNotifications();
                        // Snapshot raw → hourly rollup (son 26h, not exists ile yeni saatler)
                        purgeEvaluator.rollupSnapshotsHourly();
                        try {
                            int closed = alertService.autoResolveStale(120);
                            if (closed > 0) log.info("Auto-resolved {} stale alert (>2h)", closed);
                        } catch (Exception e) {
                            log.warn("Auto-resolve hatası: {}", e.getMessage());
                        }
                        log.info("Gunluk bakim tamamlandi");
                    } catch (Exception e) {
                        log.warn("Daily cleanup hatasi: {}", e.getMessage());
                        // Hata: guard'i geri al ki bir sonraki cycle tekrar denesin.
                        if (purgeDate.equals(lastJobPurgeDate)) lastJobPurgeDate = null;
                    }
                });
            }

            // 3c1. Manuel komutları işle (UI → API → DB → buradan execute)
            try {
                java.util.List<java.util.Map<String, Object>> cmds = jdbc.queryForList(
                    "select command_id, command, instance_pk from control.collector_command " +
                    "where status = 'pending' order by command_id limit 20");
                for (java.util.Map<String, Object> c : cmds) {
                    long cmdId = ((Number) c.get("command_id")).longValue();
                    String cmd = (String) c.get("command");
                    Long instancePk = c.get("instance_pk") != null ? ((Number) c.get("instance_pk")).longValue() : null;
                    jdbc.update("update control.collector_command set status='running' where command_id=?", cmdId);
                    try {
                        if ("refresh_settings".equals(cmd) && instancePk != null) {
                            com.pgstat.collector.model.InstanceInfo inst = inventoryRepo.findByPk(instancePk);
                            if (inst != null) nightlySnapshotCollector.collectHotSettings(inst);
                        } else if ("evaluate_alerts".equals(cmd)) {
                            // Tüm acute + rolling actionable + user-defined rule'ları hemen değerlendir
                            alertRuleEvaluator.evaluate();
                            // 1) Kanit-bazli auto-resolve (high_temp_files + temp-related user_defined_rule).
                            // "Alert'i tetikleyen sorgu hala temp yaziyor mu?" sorusunu sorar.
                            // 2) Stale fallback (high_temp_files HARIC diger 11 alert kodu icin).
                            try {
                                int closed = alertService.autoResolveStale(1);
                                if (closed > 0) log.info("Manuel evaluate sonrası {} alert stale-resolved", closed);
                            } catch (Exception ignore) {}
                        }
                        jdbc.update("update control.collector_command set status='done', processed_at=now() where command_id=?", cmdId);
                    } catch (Exception cex) {
                        jdbc.update("update control.collector_command set status='failed', processed_at=now(), error_message=? where command_id=?",
                            cex.getMessage(), cmdId);
                    }
                }
            } catch (Exception ignore) {
                // V057 yoksa veya hata: sessiz geç
            }

            // 3c2. Hot settings refresh — UTC her 3 saatte bir (00/03/06/09/12/15/18/21)
            // 11 kritik parametre (work_mem, max_connections, vb.) tekrar çekilir
            // → kullanıcı ALTER SYSTEM yaptığında alert'ler eski değer görmez.
            // Nightly snapshot 03:00'de zaten tüm parametreleri alır; bu 3 saatlik
            // çalışma onun kısa-vade tamamlayıcısıdır. Ek yük: ~11 SELECT/instance/3sa.
            if (currentUtcHour % 3 == 0 && currentUtcHour != lastHotSettingsHourUtc
                    && currentUtcHour != 3) {  // 03:00 zaten nightly full snapshot var
                lastHotSettingsHourUtc = currentUtcHour;
                try {
                    java.util.List<com.pgstat.collector.model.InstanceInfo> ready = inventoryRepo.findAllReady();
                    long total = 0;
                    for (com.pgstat.collector.model.InstanceInfo i : ready) {
                        try {
                            total += nightlySnapshotCollector.collectHotSettings(i);
                        } catch (Exception e) {
                            log.debug("Hot settings hatası {}: {}", i.instanceId(), e.getMessage());
                        }
                    }
                    if (total > 0) log.info("Hot settings refresh: {} parametre, {} instance", total, ready.size());
                } catch (Exception e) {
                    log.warn("Hot settings refresh genel hatası: {}", e.getMessage());
                    lastHotSettingsHourUtc = -1;
                }
            }

            // 3d. Nightly PG snapshot — UTC saat 3'te gunde 1 kez
            // VEYA control.nightly_snapshot_trigger tablosunda pending kayit varsa hemen calistir
            boolean nightlyTriggered = false;
            try {
                Integer pending = jdbc.queryForObject(
                    "select count(*) from control.nightly_snapshot_trigger where status = 'pending'",
                    Integer.class);
                nightlyTriggered = (pending != null && pending > 0);
            } catch (Exception ignore) {
                // Tablo henuz yoksa (V041 uygulanmamis) sessizce gec
            }

            // Saat-bazli tetik (currentUtcHour == 3) gunde 1 kez sinirlanir;
            // manuel trigger (nightlyTriggered) zaten kendi status'unu yonettigi icin guard gerekmez.
            boolean hourBasedNightly = (currentUtcHour == 3 && !todayUtc.equals(lastNightlySnapshotDate));
            if (hourBasedNightly || nightlyTriggered) {
                if (hourBasedNightly) {
                    lastNightlySnapshotDate = todayUtc;
                }
                try {
                    if (nightlyTriggered) {
                        jdbc.update("update control.nightly_snapshot_trigger set status = 'running', started_at = now() where status = 'pending'");
                    }
                    log.info("Nightly snapshot job basliyor...");
                    List<com.pgstat.collector.model.InstanceInfo> readyInstances = inventoryRepo.findAllReady();
                    long snapshotRows = 0;
                    for (com.pgstat.collector.model.InstanceInfo inst : readyInstances) {
                        try {
                            snapshotRows += nightlySnapshotCollector.collectAll(inst);
                        } catch (Exception e) {
                            log.warn("Nightly snapshot hatasi {}: {}", inst.instanceId(), e.getMessage());
                        }
                    }
                    log.info("Nightly snapshot tamamlandi: {} instance, {} satir",
                        readyInstances.size(), snapshotRows);

                    // Snapshot toplandiktan hemen sonra gunluk alert'leri de degerlendir
                    // (INDEX_SUSPECT_MISSING, INDEX_UNUSED — snapshot verisine bagli)
                    // Workload uzun-vade (90g) sınıflandırması — UTC 03:00 nightly ile aynı pencerede
                    try {
                        workloadClassifier.classifyLongTerm();
                    } catch (Exception e) {
                        log.warn("Workload uzun-vade sınıflandırma hatası: {}", e.getMessage());
                    }

                    // Snapshot tazelendi — XID/MXID freeze'i hemen yeniden degerlendir.
                    // Manuel "Snapshot Topla" sonrasi vacuum'lanan DB'lerin alert'leri
                    // 1 saatlik cycle'i beklemeden resolve olur (+ Resolved bildirimi).
                    try {
                        xidFreezeEvaluator.evaluate();
                    } catch (Exception e) {
                        log.warn("XID freeze degerlendirme hatasi (nightly sonrasi): {}", e.getMessage());
                    }

                    if (nightlyTriggered) {
                        jdbc.update("update control.nightly_snapshot_trigger set status = 'done', finished_at = now(), rows_written = ? where status = 'running'", snapshotRows);
                    }
                } catch (Exception e) {
                    log.warn("Nightly snapshot genel hatasi: {}", e.getMessage());
                    if (nightlyTriggered) {
                        jdbc.update("update control.nightly_snapshot_trigger set status = 'failed', finished_at = now() where status = 'running'");
                    }
                    if (hourBasedNightly) {
                        lastNightlySnapshotDate = null; // hata varsa bir sonraki cycle tekrar dene
                    }
                }
            }

            // 3e. Aksiyon-odakli gunluk alert'ler (INDEX_SUSPECT, INDEX_UNUSED)
            // Artik snapshot tamamlandiktan hemen sonra calisir (yukarida).
            // UTC 04:00 ayri tetik kaldirildi — snapshot yoksa zaten anlamsiz.

            // 3e-2. Freeze/settings snapshot — 6 saatte bir (XID freeze gun ici takip).
            // Nightly full snapshot zaten freeze topluyor; bu hafif varyant gun ici
            // age guncellemesi saglar ki XidFreezeEvaluator resolve'lari gece beklemesin.
            // Saat 3 haric (nightly zaten topladi). collectFreezeAndSettings agir
            // per-DB tarama yapmaz — sadece pg_settings + pg_database freeze age.
            if (currentUtcHour % 6 == 0 && currentUtcHour != lastFreezeSnapshotHourUtc
                    && currentUtcHour != 3) {
                lastFreezeSnapshotHourUtc = currentUtcHour;
                try {
                    List<com.pgstat.collector.model.InstanceInfo> ready = inventoryRepo.findAllReady();
                    long rows = 0;
                    for (com.pgstat.collector.model.InstanceInfo inst : ready) {
                        try {
                            rows += nightlySnapshotCollector.collectFreezeAndSettings(inst);
                        } catch (Exception e) {
                            log.debug("Freeze/settings snapshot hatasi {}: {}", inst.instanceId(), e.getMessage());
                        }
                    }
                    if (rows > 0) {
                        log.info("Freeze/settings 6-saatlik snapshot: {} instance, {} satir", ready.size(), rows);
                    }
                    // Taze freeze age ile XID/MXID degerlendir — gun ici resolve/alert.
                    try {
                        xidFreezeEvaluator.evaluate();
                    } catch (Exception e) {
                        log.warn("XID freeze degerlendirme hatasi (6-saatlik sonrasi): {}", e.getMessage());
                    }
                } catch (Exception e) {
                    log.warn("Freeze/settings snapshot genel hatasi: {}", e.getMessage());
                    lastFreezeSnapshotHourUtc = -1;
                }
            }

            // 3e-3. Per-table freeze snapshot — instance bazli interval (schedule_profile).
            try {
                List<com.pgstat.collector.model.InstanceInfo> ready = inventoryRepo.findAllReady();
                long freezeNowMs = System.currentTimeMillis();
                long collected = 0;
                for (com.pgstat.collector.model.InstanceInfo inst : ready) {
                    int intervalSec = inst.tableFreezeIntervalSeconds() > 0
                        ? inst.tableFreezeIntervalSeconds() : 21600;
                    long last = lastTableFreezeMillisByInstance.getOrDefault(inst.instancePk(), 0L);
                    if (freezeNowMs - last >= intervalSec * 1000L) {
                        lastTableFreezeMillisByInstance.put(inst.instancePk(), freezeNowMs);
                        try {
                            collected += nightlySnapshotCollector.collectTableFreezeOnly(inst);
                        } catch (Exception e) {
                            log.debug("Table freeze toplama hatasi {}: {}", inst.instanceId(), e.getMessage());
                        }
                    }
                }
                if (collected > 0) {
                    log.info("Table freeze snapshot: {} tablo toplandi", collected);
                }
            } catch (Exception e) {
                log.warn("Table freeze snapshot genel hatasi: {}", e.getMessage());
            }

            // 3f. Gunluk/haftalik rapor — saat config'den alinir (UI'da duzenlenebilir).
            // Idempotency: gun bazinda tek tetik (saat 1 saat surdugu icin yuzlerce
            // tekrarli rapor olusmasin diye gun bazinda guard).
            try {
                reportGenerator.processPendingManualReportTriggers();
            } catch (Exception e) {
                log.warn("Manuel rapor trigger hatasi: {}", e.getMessage());
            }

            int dailyHour = reportGenerator.dailyHourUtc();
            int weeklyHour = reportGenerator.weeklyHourUtc();
            if (currentUtcHour == dailyHour && !todayUtc.equals(lastDailyReportDate)) {
                lastDailyReportDate = todayUtc;
                try {
                    reportGenerator.generateAndSendDailyReport();
                } catch (Exception e) {
                    log.warn("Gunluk rapor hatasi: {}", e.getMessage());
                    lastDailyReportDate = null;
                }
            }
            // Pazartesi haftalik rapor (ayri saat olabilir)
            if (currentUtcHour == weeklyHour
                    && todayUtc.getDayOfWeek() == java.time.DayOfWeek.MONDAY
                    && !todayUtc.equals(lastWeeklyReportDate)) {
                lastWeeklyReportDate = todayUtc;
                try {
                    reportGenerator.generateAndSendWeeklyReport();
                } catch (Exception e) {
                    log.warn("Haftalik rapor hatasi: {}", e.getMessage());
                    lastWeeklyReportDate = null;
                }
            }

            // 4. Alert kurallarini degerlendir (user-defined rules — her cycle)
            alertRuleEvaluator.evaluate();

            // 4b. Acute alert'ler — siklik UI'dan ayarlanabilir (default 5s, 5-300s arasi).
            // LONG_RUNNING_QUERY, HIGH_CONNECTION_USAGE, STALE_DATA
            // TODO: SystemHealthEvaluator burada cagirilacak - Asama 2.

            // 4c. Frequent (Rolling) alert'ler — UI'dan ayarlanabilir (default 900s = 15dk).
            // HIGH_TEMP_FILES, IDLE_IN_TX_TIME_HIGH, REPLICATION_SLOT_INACTIVE

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
            alertService.raiseJobAlert(AlertCode.SYSTEM_CLEANUP_FAILED, ctx,
                "Rollup job basarisiz", e.getMessage());
        }

        opsRepo.finishJobRun(jobRunId, status, totalRows, 0, 0, errorText);
    }

    /**
     * Saatlik rollup interval'i (saniye). schedule_profile.hourly_rollup_interval_seconds
     * en kucuk aktif degerini okur (rollup global oldugu icin en sik isteyen profili baz al).
     * Kolon yoksa/sorgu hatasiysa 300sn (5dk) default. Rollup bu interval'den sik calismaz.
     */
    private int readHourlyRollupIntervalSec() {
        try {
            Integer v = jdbc.queryForObject(
                "select min(hourly_rollup_interval_seconds) from control.schedule_profile where is_active",
                Integer.class);
            if (v != null && v > 0) return v;
        } catch (Exception e) {
            log.debug("hourly_rollup_interval okunamadi, default 300: {}", e.getMessage());
        }
        return 300;
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
            AlertCode code = AlertCode.SYSTEM_CLEANUP_FAILED;
            java.util.Map<String, Object> ctx = new java.util.HashMap<>();
            ctx.put("job_type", jobType);
            ctx.put("failed_count", failed);
            ctx.put("total_count", succeeded + failed);
            ctx.put("succeeded_count", succeeded);
            ctx.put("error_message", errorText != null ? errorText : "—");
            ctx.put("failed_instances", errorText != null ? errorText : "—");
            ctx.put("job_run_at", java.time.Instant.now().toString());
            ctx.put("severity", failed == futures.size() ? "error" : "warning");
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
