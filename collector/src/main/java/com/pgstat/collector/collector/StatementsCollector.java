package com.pgstat.collector.collector;

import com.pgstat.collector.model.InstanceInfo;
import com.pgstat.collector.model.StatementSample;
import com.pgstat.collector.repository.CapabilityRepository;
import com.pgstat.collector.repository.DimensionRepository;
import com.pgstat.collector.repository.FactRepository;
import com.pgstat.collector.repository.StateRepository;
import com.pgstat.collector.service.DeltaCalculator;
import com.pgstat.collector.service.EpochManager;
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
                               EpochManager epochManager) {
        this.connectionFactory = connectionFactory;
        this.familyResolver = familyResolver;
        this.capabilityRepo = capabilityRepo;
        this.stateRepo = stateRepo;
        this.dimensionRepo = dimensionRepo;
        this.factRepo = factRepo;
        this.deltaCalc = deltaCalc;
        this.epochManager = epochManager;
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

        try (Connection conn = connectionFactory.connect(instance);
             Statement stmt = conn.createStatement();
             ResultSet rs = stmt.executeQuery(queries.pgssStatsQuery())) {

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
            if (queries.pgssInfoQuery() != null) {
                try (Statement stmt2 = conn.createStatement();
                     ResultSet rs2 = stmt2.executeQuery(queries.pgssInfoQuery())) {
                    if (rs2.next()) {
                        pgssResetAt = rs2.getObject("last_stats_reset", OffsetDateTime.class);
                    }
                }
            }

            String newEpochKey = epochManager.buildEpochKey(
                    systemIdentifier, pgMajor, pgssResetAt, postmasterStartAt);
            boolean epochChanged = epochManager.hasEpochChanged(currentEpochKey, newEpochKey);

            if (epochChanged) {
                // Epoch degisti → cache temizle, baseline al
                previousSamples.remove(instancePk);
                log.info("Epoch degisti, baseline alinacak: {} → {}", currentEpochKey, newEpochKey);
            }

            // Statement satirlarini oku
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
                    // Delta yazilabilir
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
                            orZeroD(deltaCalc.deltaDouble(sample.jitEmissionTime(), prev.jitEmissionTime()))
                        );
                        rowsWritten++;
                    }
                } else {
                    newSeriesCount++;
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
            rs.getLong("wal_records"),
            rs.getLong("wal_fpi"),
            rs.getLong("wal_bytes"),
            rs.getDouble("jit_generation_time"),
            rs.getDouble("jit_inlining_time"),
            rs.getDouble("jit_optimization_time"),
            rs.getDouble("jit_emission_time")
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
