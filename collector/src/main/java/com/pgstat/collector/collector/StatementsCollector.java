package com.pgstat.collector.collector;

import com.pgstat.collector.model.InstanceInfo;
import com.pgstat.collector.model.StatementSample;
import com.pgstat.collector.repository.CapabilityRepository;
import com.pgstat.collector.repository.DimensionRepository;
import com.pgstat.collector.repository.FactRepository;
import com.pgstat.collector.repository.StateRepository;
import com.pgstat.collector.service.DeltaCalculator;
import com.pgstat.collector.service.EpochManager;
import com.pgstat.collector.service.PgStatStatementsExtensionResolver;
import com.pgstat.collector.service.PgStatStatementsExtensionResolver.PgStatStatementsExtension;
import com.pgstat.collector.service.PgssResetTracker;
import com.pgstat.collector.service.SqlFamilyResolver;
import com.pgstat.collector.service.SourceConnectionFactory;
import com.pgstat.collector.sql.SourceQueries;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.OffsetDateTime;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Statements job — pg_stat_statements delta toplama.
 *
 * Adimlar:
 * 1. pg_stat_statements(false) ile sayisal verileri oku
 * 2. Her satir icin dim.statement_series upsert → statement_series_id al
 * 3. Delta hesapla (onceki sample ile); epoch degistiyse baseline al
 * 4. fact.pgss_delta INSERT (delta > 0 olan satirlar)
 * 5. Text enrichment (Phase 1G'de TextEnricher tarafindan yapilir)
 *
 * Delta cache: instancePk → (seriesKey → StatementSample)
 * Cache restart'ta kaybolur → ilk cycle baseline olur.
 */
@Component
public class StatementsCollector {

    private static final Logger log = LoggerFactory.getLogger(StatementsCollector.class);

    private final SourceConnectionFactory connectionFactory;
    private final SqlFamilyResolver familyResolver;
    private final CapabilityRepository capabilityRepo;
    private final StateRepository stateRepo;
    private final DimensionRepository dimensionRepo;
    private final FactRepository factRepo;
    private final DeltaCalculator deltaCalc;
    private final EpochManager epochManager;
    private final PgssResetTracker resetTracker;
    private final PgStatStatementsExtensionResolver pgssResolver;

    /**
     * In-memory delta cache.
     * Key: instancePk → Map<seriesKey, StatementSample>
     * seriesKey: "dbid:userid:queryid:toplevel" formatinda
     */
    private final ConcurrentHashMap<Long, Map<String, StatementSample>> previousSamples
            = new ConcurrentHashMap<>();

    public StatementsCollector(SourceConnectionFactory connectionFactory,
                               SqlFamilyResolver familyResolver,
                               CapabilityRepository capabilityRepo,
                               StateRepository stateRepo,
                               DimensionRepository dimensionRepo,
                               FactRepository factRepo,
                               DeltaCalculator deltaCalc,
                               EpochManager epochManager,
                               PgssResetTracker resetTracker,
                               PgStatStatementsExtensionResolver pgssResolver) {
        this.connectionFactory = connectionFactory;
        this.familyResolver = familyResolver;
        this.capabilityRepo = capabilityRepo;
        this.stateRepo = stateRepo;
        this.dimensionRepo = dimensionRepo;
        this.factRepo = factRepo;
        this.deltaCalc = deltaCalc;
        this.epochManager = epochManager;
        this.resetTracker = resetTracker;
        this.pgssResolver = pgssResolver;
    }

    /**
     * Statements toplama dongusu.
     *
     * @param instance hedef instance
     * @return yazilan satir sayisi ve yeni seri/text sayilari
     */
    public CollectResult collect(InstanceInfo instance) throws Exception {
        long instancePk = instance.instancePk();
        String sqlFamily = capabilityRepo.findSqlFamily(instancePk);
        Integer pgMajor = capabilityRepo.findPgMajor(instancePk);
        SourceQueries queries = familyResolver.resolveByCode(sqlFamily);
        OffsetDateTime now = OffsetDateTime.now();

        // Epoch kontrolu
        String currentEpochKey = stateRepo.findCurrentPgssEpochKey(instancePk);

        long rowsWritten = 0;
        int newSeriesCount = 0;

        // Kaynak PG'den statement istatistiklerini oku
        Map<String, StatementSample> currentSamples = new HashMap<>();

        try (Connection conn = connectionFactory.connect(instance)) {
            PgStatStatementsExtension pgssExtension = pgssResolver.resolve(conn);
            if (pgssExtension == null) {
                throw new IllegalStateException("pg_stat_statements extension admin DB'de bulunamadi: "
                        + instance.adminDbname());
            }

            String pgssFunction = pgssExtension.qualify("pg_stat_statements");
            String pgssInfoRelation = pgssExtension.qualify("pg_stat_statements_info");

            // Once role'leri yukle — pgss_delta'daki userid'leri rolname'e cevirebilmek icin
            // dim.role_ref tablosunun dolu olmasi gerek. Hafif sorgu, her cycle'da idempotent.
            try (Statement roleStmt = conn.createStatement();
                 ResultSet roleRs = roleStmt.executeQuery(
                     "select oid::bigint as userid, rolname from pg_roles")) {
                int roleCount = 0;
                while (roleRs.next()) {
                    dimensionRepo.upsertRoleRef(instancePk,
                        roleRs.getLong("userid"),
                        roleRs.getString("rolname"));
                    roleCount++;
                }
                log.debug("Role refresh: {} role yuklendi instance={}", roleCount, instancePk);
            } catch (Exception e) {
                log.warn("Role refresh hatasi instance={}: {}", instancePk, e.getMessage());
            }

            // pgss_info'dan epoch key olusturmak icin reset time lazim
            OffsetDateTime pgssResetAt = null;
            OffsetDateTime postmasterStartAt = null;
            long systemIdentifier = 0;

            // System identifier ve postmaster start icin ek sorgu
            try (Statement stmt2 = conn.createStatement();
                 ResultSet rs2 = stmt2.executeQuery(queries.discoveryQuery())) {
                if (rs2.next()) {
                    systemIdentifier = rs2.getLong("system_identifier");
                }
            }
            try (Statement stmt2 = conn.createStatement();
                 ResultSet rs2 = stmt2.executeQuery(queries.postmasterStartTimeQuery())) {
                if (rs2.next()) {
                    postmasterStartAt = rs2.getObject("start_time", OffsetDateTime.class);
                }
            }
            if (queries.supportsPgssInfo()) {
                try (Statement stmt2 = conn.createStatement();
                     ResultSet rs2 = stmt2.executeQuery(queries.pgssInfoQuery(pgssInfoRelation))) {
                    if (rs2.next()) {
                        pgssResetAt = rs2.getObject("last_stats_reset", OffsetDateTime.class);
                    }
                } catch (Exception e) {
                    log.warn("pg_stat_statements_info okunamadi instance={}: {}",
                            instancePk, e.getMessage());
                }
            }

            String newEpochKey = epochManager.buildEpochKey(
                    systemIdentifier, pgMajor, pgssResetAt, postmasterStartAt);
            boolean epochChanged = epochManager.hasEpochChanged(currentEpochKey, newEpochKey);

            if (epochChanged) {
                // Epoch degisti → reset/restart tespit edildi
                Map<String, StatementSample> oldCache = previousSamples.get(instancePk);
                
                if (oldCache != null && !oldCache.isEmpty()) {
                    long totalCalls = oldCache.values().stream().mapToLong(StatementSample::calls).sum();
                    double totalExecTime = oldCache.values().stream().mapToDouble(StatementSample::totalExecTime).sum();
                    int queryCount = oldCache.size();
                    
                    // Kayip suresi: son collect zamani ile simdi arasi
                    String lossWindow = "bilinmiyor";
                    OffsetDateTime lastCollect = null;
                    try {
                        lastCollect = stateRepo.findLastStatementsCollectAt(instancePk);
                        if (lastCollect != null) {
                            long seconds = java.time.Duration.between(lastCollect, now).getSeconds();
                            lossWindow = seconds + " saniye";
                        }
                    } catch (Exception ignored) {}
                    
                    // Reset history'ye kaydet ve pattern analizi yap
                    try {
                        resetTracker.recordReset(instancePk, newEpochKey, currentEpochKey,
                            queryCount, totalCalls, totalExecTime, lastCollect);
                    } catch (Exception e) {
                        log.warn("Reset tracker hatasi: {}", e.getMessage());
                    }
                    
                    log.warn("pg_stat_statements reset: instance={}, {} sorgu, {} calls, kayip penceresi={}",
                        instancePk, queryCount, totalCalls, lossWindow);
                } else {
                    log.info("Epoch degisti (ilk baslatma veya cache bos): {} → {}", 
                        currentEpochKey, newEpochKey);
                }
                
                previousSamples.remove(instancePk);
            }

            // Statement satirlarini oku
            try (Statement stmt = conn.createStatement();
                 ResultSet rs = stmt.executeQuery(queries.pgssStatsQuery(pgssFunction))) {
                while (rs.next()) {
                StatementSample sample = readSample(rs);
                String seriesKey = buildSeriesKey(sample);
                currentSamples.put(seriesKey, sample);

                // dim.statement_series upsert
                long seriesId = dimensionRepo.upsertStatementSeries(
                    instancePk, pgMajor, sqlFamily, systemIdentifier,
                    newEpochKey, sample.dbid(), sample.userid(),
                    sample.toplevel(), sample.queryid(), null
                );

                // Delta hesapla
                Map<String, StatementSample> prevMap = previousSamples.get(instancePk);
                StatementSample prev = prevMap != null ? prevMap.get(seriesKey) : null;

                if (prev != null && !epochChanged) {
                    // Normal delta: current - previous
                    Long callsDelta = deltaCalc.deltaLong(sample.calls(), prev.calls());
                    if (callsDelta != null && callsDelta > 0) {
                        factRepo.insertPgssDelta(now, instancePk, seriesId,
                            callsDelta,
                            orZeroL(deltaCalc.deltaLong(sample.plans(), prev.plans())),
                            orZeroD(deltaCalc.deltaDouble(sample.totalPlanTime(), prev.totalPlanTime())),
                            orZeroD(deltaCalc.deltaDouble(sample.totalExecTime(), prev.totalExecTime())),
                            orZeroL(deltaCalc.deltaLong(sample.rows(), prev.rows())),
                            orZeroL(deltaCalc.deltaLong(sample.sharedBlksHit(), prev.sharedBlksHit())),
                            orZeroL(deltaCalc.deltaLong(sample.sharedBlksRead(), prev.sharedBlksRead())),
                            orZeroL(deltaCalc.deltaLong(sample.sharedBlksDirtied(), prev.sharedBlksDirtied())),
                            orZeroL(deltaCalc.deltaLong(sample.sharedBlksWritten(), prev.sharedBlksWritten())),
                            orZeroL(deltaCalc.deltaLong(sample.localBlksHit(), prev.localBlksHit())),
                            orZeroL(deltaCalc.deltaLong(sample.localBlksRead(), prev.localBlksRead())),
                            orZeroL(deltaCalc.deltaLong(sample.localBlksDirtied(), prev.localBlksDirtied())),
                            orZeroL(deltaCalc.deltaLong(sample.localBlksWritten(), prev.localBlksWritten())),
                            orZeroL(deltaCalc.deltaLong(sample.tempBlksRead(), prev.tempBlksRead())),
                            orZeroL(deltaCalc.deltaLong(sample.tempBlksWritten(), prev.tempBlksWritten())),
                            orZeroD(deltaCalc.deltaDouble(sample.blkReadTime(), prev.blkReadTime())),
                            orZeroD(deltaCalc.deltaDouble(sample.blkWriteTime(), prev.blkWriteTime())),
                            orZeroL(deltaCalc.deltaLong(sample.walRecords(), prev.walRecords())),
                            orZeroL(deltaCalc.deltaLong(sample.walFpi(), prev.walFpi())),
                            orZeroL(deltaCalc.deltaLong(sample.walBytes(), prev.walBytes())),
                            orZeroD(deltaCalc.deltaDouble(sample.jitGenerationTime(), prev.jitGenerationTime())),
                            orZeroD(deltaCalc.deltaDouble(sample.jitInliningTime(), prev.jitInliningTime())),
                            orZeroD(deltaCalc.deltaDouble(sample.jitOptimizationTime(), prev.jitOptimizationTime())),
                            orZeroD(deltaCalc.deltaDouble(sample.jitEmissionTime(), prev.jitEmissionTime())),
                            // V055 yeni alanlar — min/max/stddev SNAPSHOT (son deger), digerleri delta
                            sample.minExecTime(), sample.maxExecTime(), sample.stddevExecTime(),
                            sample.minPlanTime(), sample.maxPlanTime(), sample.stddevPlanTime(),
                            orZeroD(deltaCalc.deltaDouble(sample.tempBlkReadTime(), prev.tempBlkReadTime())),
                            orZeroD(deltaCalc.deltaDouble(sample.tempBlkWriteTime(), prev.tempBlkWriteTime())),
                            orZeroL(deltaCalc.deltaLong(sample.walBuffersFull(), prev.walBuffersFull())),
                            orZeroL(deltaCalc.deltaLong(sample.jitFunctions(), prev.jitFunctions())),
                            orZeroL(deltaCalc.deltaLong(sample.jitDeformCount(), prev.jitDeformCount())),
                            orZeroD(deltaCalc.deltaDouble(sample.jitDeformTime(), prev.jitDeformTime())),
                            sample.statsSince(), sample.minmaxStatsSince(),
                            orZeroL(deltaCalc.deltaLong(sample.parallelWorkersToLaunch(), prev.parallelWorkersToLaunch())),
                            orZeroL(deltaCalc.deltaLong(sample.parallelWorkersLaunched(), prev.parallelWorkersLaunched())),
                            // V066 yeni alanlar — mean SNAPSHOT (current pgss snapshot degeri),
                            // jit_*_count delta, shared/local_blk_*_time delta
                            sample.meanExecTime(), sample.meanPlanTime(),
                            orZeroL(deltaCalc.deltaLong(sample.jitInliningCount(), prev.jitInliningCount())),
                            orZeroL(deltaCalc.deltaLong(sample.jitOptimizationCount(), prev.jitOptimizationCount())),
                            orZeroL(deltaCalc.deltaLong(sample.jitEmissionCount(), prev.jitEmissionCount())),
                            orZeroD(deltaCalc.deltaDouble(sample.sharedBlkReadTime(), prev.sharedBlkReadTime())),
                            orZeroD(deltaCalc.deltaDouble(sample.sharedBlkWriteTime(), prev.sharedBlkWriteTime())),
                            orZeroD(deltaCalc.deltaDouble(sample.localBlkReadTime(), prev.localBlkReadTime())),
                            orZeroD(deltaCalc.deltaDouble(sample.localBlkWriteTime(), prev.localBlkWriteTime()))
                        );
                        rowsWritten++;
                    }
                } else if (epochChanged && sample.calls() > 0) {
                    // Epoch degisti (reset/restart): cumulative degerler sifirdan basliyor,
                    // current degerin kendisi delta'dir. Ilk cycle'da bile yazilir.
                    factRepo.insertPgssDelta(now, instancePk, seriesId,
                        sample.calls(),
                        sample.plans(),
                        sample.totalPlanTime(),
                        sample.totalExecTime(),
                        sample.rows(),
                        sample.sharedBlksHit(),
                        sample.sharedBlksRead(),
                        sample.sharedBlksDirtied(),
                        sample.sharedBlksWritten(),
                        sample.localBlksHit(),
                        sample.localBlksRead(),
                        sample.localBlksDirtied(),
                        sample.localBlksWritten(),
                        sample.tempBlksRead(),
                        sample.tempBlksWritten(),
                        sample.blkReadTime(),
                        sample.blkWriteTime(),
                        sample.walRecords(),
                        sample.walFpi(),
                        sample.walBytes(),
                        sample.jitGenerationTime(),
                        sample.jitInliningTime(),
                        sample.jitOptimizationTime(),
                        sample.jitEmissionTime(),
                        // V055 yeni alanlar — epoch reset sonrasi degerler oldugu gibi delta'dir
                        sample.minExecTime(), sample.maxExecTime(), sample.stddevExecTime(),
                        sample.minPlanTime(), sample.maxPlanTime(), sample.stddevPlanTime(),
                        sample.tempBlkReadTime(), sample.tempBlkWriteTime(),
                        sample.walBuffersFull(),
                        sample.jitFunctions(), sample.jitDeformCount(), sample.jitDeformTime(),
                        sample.statsSince(), sample.minmaxStatsSince(),
                        sample.parallelWorkersToLaunch(), sample.parallelWorkersLaunched(),
                        // V066 yeni alanlar — epoch reset sonrasi degerler oldugu gibi delta'dir
                        sample.meanExecTime(), sample.meanPlanTime(),
                        sample.jitInliningCount(), sample.jitOptimizationCount(), sample.jitEmissionCount(),
                        sample.sharedBlkReadTime(), sample.sharedBlkWriteTime(),
                        sample.localBlkReadTime(), sample.localBlkWriteTime()
                    );
                    rowsWritten++;
                } else if (prevMap != null && sample.calls() > 0) {
                    // prev == null ama instance cache'i DOLU (prevMap != null):
                    // Bu instance zaten collect ediliyordu, demek ki bu sorgu YENI gorundu
                    // (iki cycle arasinda ilk kez calisti). Kumulatif degerin kendisi
                    // bu sorgunun ilk gozlem delta'sidir — bir kez bile calisan sorgu
                    // istatistiksiz kalmasin. Sonraki cycle'da normal delta'ya gecilir.
                    //
                    // NOT: prevMap == null durumu (collector restart, tum cache bos) bu
                    // dalin DISINDA kalir — orada kumulatif yazarsak aylardir biriken
                    // degerler tek dev satira yazilirdi. O durumda baseline aliriz.
                    factRepo.insertPgssDelta(now, instancePk, seriesId,
                        sample.calls(),
                        sample.plans(),
                        sample.totalPlanTime(),
                        sample.totalExecTime(),
                        sample.rows(),
                        sample.sharedBlksHit(),
                        sample.sharedBlksRead(),
                        sample.sharedBlksDirtied(),
                        sample.sharedBlksWritten(),
                        sample.localBlksHit(),
                        sample.localBlksRead(),
                        sample.localBlksDirtied(),
                        sample.localBlksWritten(),
                        sample.tempBlksRead(),
                        sample.tempBlksWritten(),
                        sample.blkReadTime(),
                        sample.blkWriteTime(),
                        sample.walRecords(),
                        sample.walFpi(),
                        sample.walBytes(),
                        sample.jitGenerationTime(),
                        sample.jitInliningTime(),
                        sample.jitOptimizationTime(),
                        sample.jitEmissionTime(),
                        sample.minExecTime(), sample.maxExecTime(), sample.stddevExecTime(),
                        sample.minPlanTime(), sample.maxPlanTime(), sample.stddevPlanTime(),
                        sample.tempBlkReadTime(), sample.tempBlkWriteTime(),
                        sample.walBuffersFull(),
                        sample.jitFunctions(), sample.jitDeformCount(), sample.jitDeformTime(),
                        sample.statsSince(), sample.minmaxStatsSince(),
                        sample.parallelWorkersToLaunch(), sample.parallelWorkersLaunched(),
                        sample.meanExecTime(), sample.meanPlanTime(),
                        sample.jitInliningCount(), sample.jitOptimizationCount(), sample.jitEmissionCount(),
                        sample.sharedBlkReadTime(), sample.sharedBlkWriteTime(),
                        sample.localBlkReadTime(), sample.localBlkWriteTime()
                    );
                    rowsWritten++;
                } else {
                    // prevMap == null && !epochChanged: collector restart sonrasi ilk cycle.
                    // Tum instance cache'i bos, epoch ayni → baseline al, delta yazma.
                    // (Kumulatif yazarsak gecmis tek satira sigardi.)
                    // Bir sonraki cycle'da delta yazilacak.
                    newSeriesCount++;
                }
                }
            }

            // Cache'i guncelle
            previousSamples.put(instancePk, currentSamples);

            // Epoch key'i kaydet
            return new CollectResult(rowsWritten, newSeriesCount, 0, newEpochKey);
        }
    }

    /** pg_stat_statements ResultSet'inden StatementSample okur. */
    private StatementSample readSample(ResultSet rs) throws Exception {
        Boolean toplevel = rs.getObject("toplevel") != null ? rs.getBoolean("toplevel") : null;
        return new StatementSample(
            rs.getLong("userid"),
            rs.getLong("dbid"),
            rs.getLong("queryid"),
            toplevel,
            rs.getLong("calls"),
            rs.getLong("plans"),
            rs.getDouble("total_plan_time"),
            rs.getDouble("total_exec_time"),
            rs.getDouble("min_exec_time"),
            rs.getDouble("max_exec_time"),
            rs.getDouble("stddev_exec_time"),
            rs.getDouble("min_plan_time"),
            rs.getDouble("max_plan_time"),
            rs.getDouble("stddev_plan_time"),
            rs.getDouble("mean_exec_time"),
            rs.getDouble("mean_plan_time"),
            rs.getLong("rows"),
            rs.getLong("shared_blks_hit"),
            rs.getLong("shared_blks_read"),
            rs.getLong("shared_blks_dirtied"),
            rs.getLong("shared_blks_written"),
            rs.getLong("local_blks_hit"),
            rs.getLong("local_blks_read"),
            rs.getLong("local_blks_dirtied"),
            rs.getLong("local_blks_written"),
            rs.getLong("temp_blks_read"),
            rs.getLong("temp_blks_written"),
            rs.getDouble("blk_read_time"),
            rs.getDouble("blk_write_time"),
            rs.getDouble("temp_blk_read_time"),
            rs.getDouble("temp_blk_write_time"),
            rs.getLong("wal_records"),
            rs.getLong("wal_fpi"),
            rs.getLong("wal_bytes"),
            rs.getLong("wal_buffers_full"),
            rs.getLong("jit_functions"),
            rs.getDouble("jit_generation_time"),
            rs.getDouble("jit_inlining_time"),
            rs.getDouble("jit_optimization_time"),
            rs.getDouble("jit_emission_time"),
            rs.getLong("jit_deform_count"),
            rs.getDouble("jit_deform_time"),
            rs.getLong("jit_inlining_count"),
            rs.getLong("jit_optimization_count"),
            rs.getLong("jit_emission_count"),
            rs.getObject("stats_since", java.time.OffsetDateTime.class),
            rs.getObject("minmax_stats_since", java.time.OffsetDateTime.class),
            rs.getLong("parallel_workers_to_launch"),
            rs.getLong("parallel_workers_launched"),
            rs.getDouble("shared_blk_read_time"),
            rs.getDouble("shared_blk_write_time"),
            rs.getDouble("local_blk_read_time"),
            rs.getDouble("local_blk_write_time")
        );
    }

    /** Delta cache key: "dbid:userid:queryid:toplevel" */
    private String buildSeriesKey(StatementSample s) {
        return s.dbid() + ":" + s.userid() + ":" + s.queryid() + ":" + s.toplevel();
    }

    /** Null-safe: null → 0 */
    private long orZeroL(Long val) { return val != null ? val : 0L; }
    private double orZeroD(Double val) { return val != null ? val : 0.0; }

    /** Delta cache temizle (epoch degisimi veya restart). */
    public void clearCache(long instancePk) {
        previousSamples.remove(instancePk);
    }

    /** Statements toplama sonucu. */
    public record CollectResult(
        long rowsWritten,
        int newSeriesCount,
        int newQueryTextCount,
        String epochKey
    ) {}
}
