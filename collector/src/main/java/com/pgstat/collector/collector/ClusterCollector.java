package com.pgstat.collector.collector;

import com.pgstat.collector.model.AlertCode;
import com.pgstat.collector.model.ClusterMetricSample;
import com.pgstat.collector.model.InstanceInfo;
import com.pgstat.collector.repository.AlertRepository;
import com.pgstat.collector.repository.CapabilityRepository;
import com.pgstat.collector.repository.FactRepository;
import com.pgstat.collector.service.DeltaCalculator;
import com.pgstat.collector.service.SqlFamilyResolver;
import com.pgstat.collector.service.SourceConnectionFactory;
import com.pgstat.collector.sql.SourceQueries;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.Statement;
import java.time.OffsetDateTime;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Cluster job — 10-adimli toplama sureci.
 *
 * Adimlar:
 *  1. pg_is_in_recovery → is_primary belirle
 *  2. pg_stat_bgwriter / pg_stat_wal / pg_stat_checkpointer → delta → fact.pg_cluster_delta
 *  3. pg_stat_io (PG16+) → delta → fact.pg_io_stat_delta
 *  4. pg_stat_activity → fact.pg_activity_snapshot
 *  5. pg_stat_replication (primary only) → fact.pg_replication_snapshot
 *  6. Replication lag esik kontrolu → alert
 *  7. pg_locks (granted=false) → fact.pg_lock_snapshot + lock_contention alert
 *  8. pg_stat_progress_* → fact.pg_progress_snapshot
 *  9. instance_state.last_cluster_collect_at guncelle
 * 10. job_run_instance UPDATE
 *
 * Adim 9 ve 10, JobOrchestrator tarafindan yurutulur.
 */
@Component
public class ClusterCollector {

    private static final Logger log = LoggerFactory.getLogger(ClusterCollector.class);

    /** Replication lag alert esigi (5 dakika) */
    private static final long REPLICATION_LAG_THRESHOLD_SECONDS = 300;

    /** Lock bekleme alert esigi (5 dakika, millisaniye cinsinden) */
    private static final long LOCK_WAIT_THRESHOLD_MS = 300_000;

    private final SourceConnectionFactory connectionFactory;
    private final SqlFamilyResolver familyResolver;
    private final FactRepository factRepo;
    private final CapabilityRepository capabilityRepo;
    private final AlertRepository alertRepo;
    private final DeltaCalculator deltaCalc;

    /** In-memory delta cache: instancePk → onceki cluster metric sample */
    private final ConcurrentHashMap<Long, ClusterMetricSample> previousSamples = new ConcurrentHashMap<>();

    /** In-memory delta cache: instancePk → onceki io_stat sample */
    private final ConcurrentHashMap<Long, Map<String, Map<String, Double>>> previousIoSamples = new ConcurrentHashMap<>();

    public ClusterCollector(SourceConnectionFactory connectionFactory,
                            SqlFamilyResolver familyResolver,
                            FactRepository factRepo,
                            CapabilityRepository capabilityRepo,
                            AlertRepository alertRepo,
                            DeltaCalculator deltaCalc) {
        this.connectionFactory = connectionFactory;
        this.familyResolver = familyResolver;
        this.factRepo = factRepo;
        this.capabilityRepo = capabilityRepo;
        this.alertRepo = alertRepo;
        this.deltaCalc = deltaCalc;
    }

    /**
     * Cluster toplama dongusu — 8 adim (9-10 disarida).
     * Her adim bagimsiz try-catch icinde calisir — bir adimin hatasi digerlerini engellemez.
     *
     * @param instance hedef instance
     * @return yazilan toplam satir sayisi
     */
    public long collect(InstanceInfo instance) throws Exception {
        long instancePk = instance.instancePk();
        String sqlFamily = capabilityRepo.findSqlFamily(instancePk);
        Integer pgMajor = capabilityRepo.findPgMajor(instancePk);
        SourceQueries queries = familyResolver.resolveByCode(sqlFamily);
        OffsetDateTime now = OffsetDateTime.now();
        long rowsWritten = 0;

        try (Connection conn = connectionFactory.connect(instance)) {

            // Adim 1: is_primary kontrolu
            boolean isPrimary;
            try (Statement stmt = conn.createStatement();
                 ResultSet rs = stmt.executeQuery("select pg_is_in_recovery() as in_recovery")) {
                rs.next();
                isPrimary = !rs.getBoolean("in_recovery");
            }

            // Adim 2: Cluster metrikleri (bgwriter + wal + checkpointer)
            try {
                rowsWritten += collectClusterMetrics(conn, queries, instancePk, now);
            } catch (Exception e) {
                log.warn("Cluster metrikleri toplama hatasi: {} — {}", instance.instanceId(), e.getMessage());
            }

            // Adim 3: IO stat (PG16+ — pgMajor bazli kontrol)
            if (pgMajor != null && pgMajor >= 16 && queries.ioStatQuery() != null) {
                try {
                    rowsWritten += collectIoStats(conn, queries, instancePk, now);
                } catch (Exception e) {
                    log.warn("IO stat toplama hatasi: {} — {}", instance.instanceId(), e.getMessage());
                }
            }

            // Adim 4: Activity snapshot
            try {
                rowsWritten += collectActivity(conn, queries, instancePk, now);
            } catch (Exception e) {
                log.warn("Activity snapshot hatasi: {} — {}", instance.instanceId(), e.getMessage());
            }

            // Adim 5: Replication snapshot (yalnizca primary)
            if (isPrimary) {
                try {
                    rowsWritten += collectReplication(conn, queries, instancePk, now);
                } catch (Exception e) {
                    log.warn("Replication snapshot hatasi: {} — {}", instance.instanceId(), e.getMessage());
                }
            }

            // Adim 6: Replication lag alert kontrolu
            // (collectReplication icinde kontrol ediliyor)

            // Adim 7: Lock snapshot + alert
            try {
                rowsWritten += collectLocks(conn, queries, instancePk, now);
            } catch (Exception e) {
                log.warn("Lock snapshot hatasi: {} — {}", instance.instanceId(), e.getMessage());
            }

            // Adim 8: Progress snapshot
            try {
                rowsWritten += collectProgress(conn, queries, instancePk, now);
            } catch (Exception e) {
                log.warn("Progress snapshot hatasi: {} — {}", instance.instanceId(), e.getMessage());
            }
        }

        log.debug("Cluster toplama tamamlandi: {} — {} satir", instance.instanceId(), rowsWritten);
        return rowsWritten;
    }

    // =========================================================================
    // Adim 2: Cluster metrikleri (delta)
    // =========================================================================

    private long collectClusterMetrics(Connection conn, SourceQueries queries,
                                       long instancePk, OffsetDateTime now) throws Exception {
        Map<String, Double> currentMetrics = new LinkedHashMap<>();

        // bgwriter
        readMetrics(conn, queries.bgwriterQuery(), "pg_stat_bgwriter", currentMetrics);

        // wal (PG13+)
        if (queries.walQuery() != null) {
            readMetrics(conn, queries.walQuery(), "pg_stat_wal", currentMetrics);
        }

        // checkpointer (PG17+)
        if (queries.checkpointerQuery() != null) {
            readMetrics(conn, queries.checkpointerQuery(), "pg_stat_checkpointer", currentMetrics);
        }

        ClusterMetricSample current = new ClusterMetricSample(instancePk, currentMetrics);
        ClusterMetricSample previous = previousSamples.put(instancePk, current);

        if (previous == null) {
            // Ilk sample — baseline, delta yok
            log.debug("Cluster baseline alindi: instance_pk={}", instancePk);
            return 0;
        }

        // Delta hesapla ve yaz
        List<Object[]> deltas = new ArrayList<>();
        for (Map.Entry<String, Double> entry : currentMetrics.entrySet()) {
            String key = entry.getKey();
            String[] parts = key.split("\\.", 2);
            String family = parts[0];
            String name = parts[1];
            Double prevVal = previous.metrics().get(key);
            Double delta = deltaCalc.deltaDouble(entry.getValue(), prevVal);
            if (delta != null) {
                deltas.add(new Object[]{family, name, delta});
            }
        }

        if (!deltas.isEmpty()) {
            factRepo.insertClusterDeltaBatch(now, instancePk, deltas.toArray(new Object[0][]));
        }

        return deltas.size();
    }

    /** Bir sorgudan tum sayisal kolonlari family.name formatinda okur. */
    private void readMetrics(Connection conn, String sql, String family,
                             Map<String, Double> target) throws Exception {
        try (Statement stmt = conn.createStatement();
             ResultSet rs = stmt.executeQuery(sql)) {
            if (rs.next()) {
                ResultSetMetaData meta = rs.getMetaData();
                for (int i = 1; i <= meta.getColumnCount(); i++) {
                    String colName = meta.getColumnName(i);
                    double val = rs.getDouble(i);
                    if (!rs.wasNull()) {
                        target.put(family + "." + colName, val);
                    }
                }
            }
        }
    }

    // =========================================================================
    // Adim 3: IO stat delta
    // =========================================================================

    private long collectIoStats(Connection conn, SourceQueries queries,
                                long instancePk, OffsetDateTime now) throws Exception {
        // Key: "backendType|object|context" → metrikName → kumulatif deger
        Map<String, Map<String, Double>> currentSamples = new LinkedHashMap<>();

        try (Statement stmt = conn.createStatement();
             ResultSet rs = stmt.executeQuery(queries.ioStatQuery())) {
            while (rs.next()) {
                String key = rs.getString("backend_type") + "|" +
                             rs.getString("object") + "|" +
                             rs.getString("context");
                Map<String, Double> metrics = new LinkedHashMap<>();
                metrics.put("reads", getDoubleOrZero(rs, "reads"));
                metrics.put("read_time", getDoubleOrZero(rs, "read_time"));
                metrics.put("writes", getDoubleOrZero(rs, "writes"));
                metrics.put("write_time", getDoubleOrZero(rs, "write_time"));
                metrics.put("extends", getDoubleOrZero(rs, "extends"));
                metrics.put("extend_time", getDoubleOrZero(rs, "extend_time"));
                metrics.put("hits", getDoubleOrZero(rs, "hits"));
                metrics.put("evictions", getDoubleOrZero(rs, "evictions"));
                metrics.put("reuses", getDoubleOrZero(rs, "reuses"));
                metrics.put("fsyncs", getDoubleOrZero(rs, "fsyncs"));
                metrics.put("fsync_time", getDoubleOrZero(rs, "fsync_time"));
                currentSamples.put(key, metrics);
            }
        }

        Map<String, Map<String, Double>> prevSamples = previousIoSamples.put(instancePk, currentSamples);

        if (prevSamples == null) {
            log.debug("IO stat baseline alindi: instance_pk={}", instancePk);
            return 0;
        }

        long rowsWritten = 0;
        for (Map.Entry<String, Map<String, Double>> entry : currentSamples.entrySet()) {
            String[] parts = entry.getKey().split("\\|", 3);
            Map<String, Double> prev = prevSamples.get(entry.getKey());
            Map<String, Double> curr = entry.getValue();

            if (prev == null) continue; // Yeni satir — baseline

            Long readsDelta = deltaCalc.deltaLong(curr.get("reads").longValue(),
                    prev.get("reads") != null ? prev.get("reads").longValue() : null);
            // Herhangi bir delta varsa yaz
            factRepo.insertIoStatDelta(now, instancePk,
                parts[0], parts[1], parts[2],
                readsDelta,
                deltaCalc.deltaDouble(curr.get("read_time"), prev.get("read_time")),
                deltaCalc.deltaLong(curr.get("writes").longValue(), prev.get("writes").longValue()),
                deltaCalc.deltaDouble(curr.get("write_time"), prev.get("write_time")),
                deltaCalc.deltaLong(curr.get("extends").longValue(), prev.get("extends").longValue()),
                deltaCalc.deltaDouble(curr.get("extend_time"), prev.get("extend_time")),
                deltaCalc.deltaLong(curr.get("hits").longValue(), prev.get("hits").longValue()),
                deltaCalc.deltaLong(curr.get("evictions").longValue(), prev.get("evictions").longValue()),
                deltaCalc.deltaLong(curr.get("reuses").longValue(), prev.get("reuses").longValue()),
                deltaCalc.deltaLong(curr.get("fsyncs").longValue(), prev.get("fsyncs").longValue()),
                deltaCalc.deltaDouble(curr.get("fsync_time"), prev.get("fsync_time"))
            );
            rowsWritten++;
        }
        return rowsWritten;
    }

    private double getDoubleOrZero(ResultSet rs, String col) throws Exception {
        double val = rs.getDouble(col);
        return rs.wasNull() ? 0.0 : val;
    }

    // =========================================================================
    // Adim 4: Activity snapshot
    // =========================================================================

    private long collectActivity(Connection conn, SourceQueries queries,
                                 long instancePk, OffsetDateTime now) throws Exception {
        long rows = 0;
        try (Statement stmt = conn.createStatement();
             ResultSet rs = stmt.executeQuery(queries.activityQuery())) {
            while (rs.next()) {
                factRepo.insertActivitySnapshot(now, instancePk,
                    rs.getInt("pid"),
                    rs.getString("datname"),
                    rs.getString("usename"),
                    rs.getString("application_name"),
                    rs.getString("client_addr"),
                    rs.getObject("backend_start", OffsetDateTime.class),
                    rs.getObject("xact_start", OffsetDateTime.class),
                    rs.getObject("query_start", OffsetDateTime.class),
                    rs.getObject("state_change", OffsetDateTime.class),
                    rs.getString("state"),
                    rs.getString("wait_event_type"),
                    rs.getString("wait_event"),
                    rs.getString("query"),
                    rs.getString("backend_type")
                );
                rows++;
            }
        }
        return rows;
    }

    // =========================================================================
    // Adim 5-6: Replication snapshot + lag alert
    // =========================================================================

    private long collectReplication(Connection conn, SourceQueries queries,
                                    long instancePk, OffsetDateTime now) throws Exception {
        long rows = 0;
        try (Statement stmt = conn.createStatement();
             ResultSet rs = stmt.executeQuery(queries.replicationQuery())) {
            while (rs.next()) {
                long replayLagBytes = rs.getLong("replay_lag_bytes");
                String replayLagStr = rs.getString("replay_lag");

                factRepo.insertReplicationSnapshot(now, instancePk,
                    rs.getInt("pid"),
                    rs.getString("usename"),
                    rs.getString("application_name"),
                    rs.getString("client_addr"),
                    rs.getString("state"),
                    rs.getString("sent_lsn"),
                    rs.getString("write_lsn"),
                    rs.getString("flush_lsn"),
                    rs.getString("replay_lsn"),
                    rs.getString("write_lag"),
                    rs.getString("flush_lag"),
                    replayLagStr,
                    rs.getString("sync_state"),
                    replayLagBytes
                );
                rows++;

                // Adim 6: Replication lag alert kontrolu
                checkReplicationLagAlert(instancePk, replayLagStr, replayLagBytes);
            }
        }
        return rows;
    }

    private void checkReplicationLagAlert(long instancePk, String replayLagStr,
                                          long replayLagBytes) {
        // replay_lag null degilse ve interval olarak parse edilebilirse kontrol et
        // Basit kontrol: replay_lag_bytes > 0 ve lag string'i "00:05" ten buyukse
        // Gercek uygulamada interval parse yapilir; burada bytes bazli threshold
        if (replayLagBytes > 100_000_000) { // 100MB uzerinde lag
            String alertKey = "replication_lag:instance:" + instancePk;
            alertRepo.upsert(alertKey, AlertCode.REPLICATION_LAG,
                instancePk, null, null,
                "Yuksek replication lag",
                "Replay lag: " + replayLagStr + " (" + replayLagBytes + " bytes)",
                null);
        }
    }

    // =========================================================================
    // Adim 7: Lock snapshot + alert
    // =========================================================================

    private long collectLocks(Connection conn, SourceQueries queries,
                              long instancePk, OffsetDateTime now) throws Exception {
        long rows = 0;
        try (Statement stmt = conn.createStatement();
             ResultSet rs = stmt.executeQuery(queries.lockQuery())) {
            while (rs.next()) {
                OffsetDateTime waitstart = rs.getObject("waitstart", OffsetDateTime.class);

                // blocked_by_pids — integer array
                java.sql.Array blockedArr = rs.getArray("blocked_by_pids");
                Integer[] blockedByPids = blockedArr != null
                        ? (Integer[]) blockedArr.getArray()
                        : new Integer[0];

                factRepo.insertLockSnapshot(now, instancePk,
                    rs.getInt("pid"),
                    rs.getString("locktype"),
                    rs.getObject("database_oid") != null ? rs.getLong("database_oid") : null,
                    rs.getObject("relation_oid") != null ? rs.getLong("relation_oid") : null,
                    rs.getString("mode"),
                    rs.getBoolean("granted"),
                    waitstart,
                    blockedByPids
                );
                rows++;

                // Lock contention alert: 5 dakikadan fazla bekleyen lock
                if (waitstart != null) {
                    long waitMs = java.time.Duration.between(waitstart, now).toMillis();
                    if (waitMs > LOCK_WAIT_THRESHOLD_MS) {
                        String alertKey = "lock_contention:instance:" + instancePk;
                        alertRepo.upsert(alertKey, AlertCode.LOCK_CONTENTION,
                            instancePk, null, null,
                            "Uzun sureli lock bekleme",
                            "PID " + rs.getInt("pid") + " " + (waitMs / 1000) + "s suredir bekliyor, mode=" + rs.getString("mode"),
                            null);
                    }
                }
            }
        }
        return rows;
    }

    // =========================================================================
    // Adim 8: Progress snapshot
    // =========================================================================

    private long collectProgress(Connection conn, SourceQueries queries,
                                 long instancePk, OffsetDateTime now) throws Exception {
        long rows = 0;

        // VACUUM progress (tum surumlerde)
        rows += collectProgressQuery(conn, queries.progressVacuumQuery(), instancePk, now);

        // ANALYZE progress (PG13+)
        if (queries.progressAnalyzeQuery() != null) {
            rows += collectProgressQuery(conn, queries.progressAnalyzeQuery(), instancePk, now);
        }

        // CREATE INDEX progress (PG12+)
        if (queries.progressCreateIndexQuery() != null) {
            rows += collectProgressQuery(conn, queries.progressCreateIndexQuery(), instancePk, now);
        }

        return rows;
    }

    private long collectProgressQuery(Connection conn, String sql,
                                      long instancePk, OffsetDateTime now) throws Exception {
        long rows = 0;
        try (Statement stmt = conn.createStatement();
             ResultSet rs = stmt.executeQuery(sql)) {
            while (rs.next()) {
                Double pct = rs.getDouble("progress_pct");
                if (rs.wasNull()) pct = null;

                factRepo.insertProgressSnapshot(now, instancePk,
                    rs.getInt("pid"),
                    rs.getString("command"),
                    rs.getString("datname"),
                    rs.getString("relname"),
                    rs.getString("phase"),
                    rs.getObject("blocks_total") != null ? rs.getLong("blocks_total") : null,
                    rs.getObject("blocks_done") != null ? rs.getLong("blocks_done") : null,
                    rs.getObject("tuples_total") != null ? rs.getLong("tuples_total") : null,
                    rs.getObject("tuples_done") != null ? rs.getLong("tuples_done") : null,
                    pct
                );
                rows++;
            }
        }
        return rows;
    }

    /** Delta cache'i temizler (restart veya epoch degisimi). */
    public void clearCache(long instancePk) {
        previousSamples.remove(instancePk);
        previousIoSamples.remove(instancePk);
    }
}
