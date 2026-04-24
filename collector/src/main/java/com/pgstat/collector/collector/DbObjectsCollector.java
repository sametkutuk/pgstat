package com.pgstat.collector.collector;

import com.pgstat.collector.model.DbObjectsTarget;
import com.pgstat.collector.model.InstanceInfo;
import com.pgstat.collector.repository.CapabilityRepository;
import com.pgstat.collector.repository.DimensionRepository;
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
import java.sql.Statement;
import java.time.OffsetDateTime;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * DbObjects job — per-database tablo ve index istatistikleri toplama.
 *
 * Adimlar:
 * 1. Hedef database'e baglan (admin_dbname degil, datname'e baglanir)
 * 2. pg_stat_user_tables + pg_statio_user_tables → delta → fact.pg_table_stat_delta
 * 3. pg_stat_user_indexes + pg_statio_user_indexes → delta → fact.pg_index_stat_delta
 * 4. pg_stat_database → delta → fact.pg_database_delta
 * 5. dim.relation_ref upsert (yeni tablo/index kesfedilmisse)
 *
 * Delta cache: "instancePk:dbid" → (relid → kumulatif degerler Map)
 */
@Component
public class DbObjectsCollector {

    private static final Logger log = LoggerFactory.getLogger(DbObjectsCollector.class);

    private final SourceConnectionFactory connectionFactory;
    private final SqlFamilyResolver familyResolver;
    private final CapabilityRepository capabilityRepo;
    private final DimensionRepository dimensionRepo;
    private final FactRepository factRepo;
    private final DeltaCalculator deltaCalc;

    /** Table stats delta cache: "instancePk:dbid:relid" → metrik map */
    private final ConcurrentHashMap<String, Map<String, Long>> previousTableStats = new ConcurrentHashMap<>();

    /** Index stats delta cache: "instancePk:dbid:indexRelid" → metrik map */
    private final ConcurrentHashMap<String, Map<String, Long>> previousIndexStats = new ConcurrentHashMap<>();

    /** Database stats delta cache: "instancePk:dbid" → metrik map */
    private final ConcurrentHashMap<String, Map<String, Double>> previousDbStats = new ConcurrentHashMap<>();

    public DbObjectsCollector(SourceConnectionFactory connectionFactory,
                              SqlFamilyResolver familyResolver,
                              CapabilityRepository capabilityRepo,
                              DimensionRepository dimensionRepo,
                              FactRepository factRepo,
                              DeltaCalculator deltaCalc) {
        this.connectionFactory = connectionFactory;
        this.familyResolver = familyResolver;
        this.capabilityRepo = capabilityRepo;
        this.dimensionRepo = dimensionRepo;
        this.factRepo = factRepo;
        this.deltaCalc = deltaCalc;
    }

    /**
     * Per-database istatistik toplama.
     * Instance'a datname uzerinden baglanir (admin_dbname degil).
     *
     * @param target due database bilgileri
     * @return yazilan satir sayisi
     */
    public long collect(DbObjectsTarget target) throws Exception {
        long instancePk = target.instancePk();
        String sqlFamily = capabilityRepo.findSqlFamily(instancePk);
        SourceQueries queries = familyResolver.resolveByCode(sqlFamily);
        OffsetDateTime now = OffsetDateTime.now();
        long rowsWritten = 0;

        // Hedef database'e baglanmak icin InstanceInfo olustur
        InstanceInfo instanceForDb = new InstanceInfo(
            target.instancePk(), target.instanceId(),
            target.host(), target.port(), target.datname(),
            target.secretRef(), target.sslMode(), "ready",
            target.collectorUsername(),
            target.connectTimeoutSeconds(), target.statementTimeoutMs(),
            target.lockTimeoutMs(), 0, 60, 300, null, null
        );

        try (Connection conn = connectionFactory.connect(instanceForDb)) {

            // Database-level stats (pg_stat_database icin admin_dbname'den baglanabilir ama
            // burada zaten datname'e baglandik — tum veritabanlari icin metrikler doner)
            rowsWritten += collectDatabaseStats(conn, queries, instancePk, target.dbid(),
                    target.datname(), now);

            // Table stats
            rowsWritten += collectTableStats(conn, queries, instancePk, target.dbid(), now);

            // Index stats
            rowsWritten += collectIndexStats(conn, queries, instancePk, target.dbid(), now);
        }

        log.debug("DbObjects toplama tamamlandi: {}:{} — {} satir",
                target.instanceId(), target.datname(), rowsWritten);

        return rowsWritten;
    }

    // -------------------------------------------------------------------------
    // Database stats
    // -------------------------------------------------------------------------

    private long collectDatabaseStats(Connection conn, SourceQueries queries,
                                      long instancePk, long dbid, String datname,
                                      OffsetDateTime now) throws Exception {
        String cacheKey = instancePk + ":" + dbid;
        Map<String, Double> current = new HashMap<>();

        try (Statement stmt = conn.createStatement();
             ResultSet rs = stmt.executeQuery(queries.databaseStatsQuery())) {
            while (rs.next()) {
                if (rs.getLong("dbid") != dbid) continue; // Sadece hedef DB

                current.put("numbackends", (double) rs.getInt("numbackends"));
                current.put("xact_commit", rs.getDouble("xact_commit"));
                current.put("xact_rollback", rs.getDouble("xact_rollback"));
                current.put("blks_read", rs.getDouble("blks_read"));
                current.put("blks_hit", rs.getDouble("blks_hit"));
                current.put("tup_returned", rs.getDouble("tup_returned"));
                current.put("tup_fetched", rs.getDouble("tup_fetched"));
                current.put("tup_inserted", rs.getDouble("tup_inserted"));
                current.put("tup_updated", rs.getDouble("tup_updated"));
                current.put("tup_deleted", rs.getDouble("tup_deleted"));
                current.put("conflicts", rs.getDouble("conflicts"));
                current.put("temp_files", rs.getDouble("temp_files"));
                current.put("temp_bytes", rs.getDouble("temp_bytes"));
                current.put("deadlocks", rs.getDouble("deadlocks"));
                current.put("checksum_failures", rs.getDouble("checksum_failures"));
                current.put("blk_read_time", rs.getDouble("blk_read_time"));
                current.put("blk_write_time", rs.getDouble("blk_write_time"));
                current.put("session_time", rs.getDouble("session_time"));
                current.put("active_time", rs.getDouble("active_time"));
                current.put("idle_in_transaction_time", rs.getDouble("idle_in_transaction_time"));
                break;
            }
        }

        Map<String, Double> prev = previousDbStats.put(cacheKey, current);
        if (prev == null || current.isEmpty()) return 0;

        int numbackends = current.get("numbackends").intValue();

        factRepo.insertDatabaseDelta(now, instancePk, dbid, datname, numbackends,
            d2l(deltaCalc.deltaDouble(current.get("xact_commit"), prev.get("xact_commit"))),
            d2l(deltaCalc.deltaDouble(current.get("xact_rollback"), prev.get("xact_rollback"))),
            d2l(deltaCalc.deltaDouble(current.get("blks_read"), prev.get("blks_read"))),
            d2l(deltaCalc.deltaDouble(current.get("blks_hit"), prev.get("blks_hit"))),
            d2l(deltaCalc.deltaDouble(current.get("tup_returned"), prev.get("tup_returned"))),
            d2l(deltaCalc.deltaDouble(current.get("tup_fetched"), prev.get("tup_fetched"))),
            d2l(deltaCalc.deltaDouble(current.get("tup_inserted"), prev.get("tup_inserted"))),
            d2l(deltaCalc.deltaDouble(current.get("tup_updated"), prev.get("tup_updated"))),
            d2l(deltaCalc.deltaDouble(current.get("tup_deleted"), prev.get("tup_deleted"))),
            d2l(deltaCalc.deltaDouble(current.get("conflicts"), prev.get("conflicts"))),
            d2l(deltaCalc.deltaDouble(current.get("temp_files"), prev.get("temp_files"))),
            d2l(deltaCalc.deltaDouble(current.get("temp_bytes"), prev.get("temp_bytes"))),
            d2l(deltaCalc.deltaDouble(current.get("deadlocks"), prev.get("deadlocks"))),
            d2l(deltaCalc.deltaDouble(current.get("checksum_failures"), prev.get("checksum_failures"))),
            orZeroD(deltaCalc.deltaDouble(current.get("blk_read_time"), prev.get("blk_read_time"))),
            orZeroD(deltaCalc.deltaDouble(current.get("blk_write_time"), prev.get("blk_write_time"))),
            orZeroD(deltaCalc.deltaDouble(current.get("session_time"), prev.get("session_time"))),
            orZeroD(deltaCalc.deltaDouble(current.get("active_time"), prev.get("active_time"))),
            orZeroD(deltaCalc.deltaDouble(current.get("idle_in_transaction_time"), prev.get("idle_in_transaction_time")))
        );
        return 1;
    }

    // -------------------------------------------------------------------------
    // Table stats
    // -------------------------------------------------------------------------

    private long collectTableStats(Connection conn, SourceQueries queries,
                                   long instancePk, long dbid,
                                   OffsetDateTime now) throws Exception {
        long rows = 0;

        try (Statement stmt = conn.createStatement();
             ResultSet rs = stmt.executeQuery(queries.tableStatsQuery())) {
            while (rs.next()) {
                long relid = rs.getLong("relid");
                String schemaname = rs.getString("schemaname");
                String relname = rs.getString("relname");

                // dim.relation_ref upsert
                dimensionRepo.upsertRelationRef(instancePk, dbid, relid,
                        schemaname, relname, "r"); // 'r' = ordinary table

                // Kumulatif degerler
                String cacheKey = instancePk + ":" + dbid + ":" + relid;
                Map<String, Long> current = new HashMap<>();
                current.put("seq_scan", rs.getLong("seq_scan"));
                current.put("seq_tup_read", rs.getLong("seq_tup_read"));
                current.put("idx_scan", rs.getLong("idx_scan"));
                current.put("idx_tup_fetch", rs.getLong("idx_tup_fetch"));
                current.put("n_tup_ins", rs.getLong("n_tup_ins"));
                current.put("n_tup_upd", rs.getLong("n_tup_upd"));
                current.put("n_tup_del", rs.getLong("n_tup_del"));
                current.put("n_tup_hot_upd", rs.getLong("n_tup_hot_upd"));
                current.put("vacuum_count", rs.getLong("vacuum_count"));
                current.put("autovacuum_count", rs.getLong("autovacuum_count"));
                current.put("analyze_count", rs.getLong("analyze_count"));
                current.put("autoanalyze_count", rs.getLong("autoanalyze_count"));
                current.put("heap_blks_read", rs.getLong("heap_blks_read"));
                current.put("heap_blks_hit", rs.getLong("heap_blks_hit"));
                current.put("idx_blks_read", rs.getLong("idx_blks_read"));
                current.put("idx_blks_hit", rs.getLong("idx_blks_hit"));
                current.put("toast_blks_read", rs.getLong("toast_blks_read"));
                current.put("toast_blks_hit", rs.getLong("toast_blks_hit"));
                current.put("tidx_blks_read", rs.getLong("tidx_blks_read"));
                current.put("tidx_blks_hit", rs.getLong("tidx_blks_hit"));

                // Gauge degerler (delta degil, anlik)
                long nLiveTup = rs.getLong("n_live_tup");
                long nDeadTup = rs.getLong("n_dead_tup");
                long nModSinceAnalyze = rs.getLong("n_mod_since_analyze");

                Map<String, Long> prev = previousTableStats.put(cacheKey, current);
                if (prev == null) continue; // Baseline

                factRepo.insertTableStatDelta(now, instancePk, dbid, relid, schemaname, relname,
                    d(prev, current, "seq_scan"), d(prev, current, "seq_tup_read"),
                    d(prev, current, "idx_scan"), d(prev, current, "idx_tup_fetch"),
                    d(prev, current, "n_tup_ins"), d(prev, current, "n_tup_upd"),
                    d(prev, current, "n_tup_del"), d(prev, current, "n_tup_hot_upd"),
                    d(prev, current, "vacuum_count"), d(prev, current, "autovacuum_count"),
                    d(prev, current, "analyze_count"), d(prev, current, "autoanalyze_count"),
                    d(prev, current, "heap_blks_read"), d(prev, current, "heap_blks_hit"),
                    d(prev, current, "idx_blks_read"), d(prev, current, "idx_blks_hit"),
                    d(prev, current, "toast_blks_read"), d(prev, current, "toast_blks_hit"),
                    d(prev, current, "tidx_blks_read"), d(prev, current, "tidx_blks_hit"),
                    nLiveTup, nDeadTup, nModSinceAnalyze
                );
                rows++;
            }
        }
        return rows;
    }

    // -------------------------------------------------------------------------
    // Index stats
    // -------------------------------------------------------------------------

    private long collectIndexStats(Connection conn, SourceQueries queries,
                                   long instancePk, long dbid,
                                   OffsetDateTime now) throws Exception {
        long rows = 0;

        try (Statement stmt = conn.createStatement();
             ResultSet rs = stmt.executeQuery(queries.indexStatsQuery())) {
            while (rs.next()) {
                long tableRelid = rs.getLong("table_relid");
                long indexRelid = rs.getLong("index_relid");
                String schemaname = rs.getString("schemaname");
                String tableRelname = rs.getString("table_relname");
                String indexRelname = rs.getString("index_relname");

                // dim.relation_ref upsert (index icin)
                dimensionRepo.upsertRelationRef(instancePk, dbid, indexRelid,
                        schemaname, indexRelname, "i"); // 'i' = index

                String cacheKey = instancePk + ":" + dbid + ":" + indexRelid;
                Map<String, Long> current = new HashMap<>();
                current.put("idx_scan", rs.getLong("idx_scan"));
                current.put("idx_tup_read", rs.getLong("idx_tup_read"));
                current.put("idx_tup_fetch", rs.getLong("idx_tup_fetch"));
                current.put("idx_blks_read", rs.getLong("idx_blks_read"));
                current.put("idx_blks_hit", rs.getLong("idx_blks_hit"));

                Map<String, Long> prev = previousIndexStats.put(cacheKey, current);
                if (prev == null) continue;

                factRepo.insertIndexStatDelta(now, instancePk, dbid, tableRelid, indexRelid,
                    schemaname, tableRelname, indexRelname,
                    d(prev, current, "idx_scan"), d(prev, current, "idx_tup_read"),
                    d(prev, current, "idx_tup_fetch"),
                    d(prev, current, "idx_blks_read"), d(prev, current, "idx_blks_hit")
                );
                rows++;
            }
        }
        return rows;
    }

    // -------------------------------------------------------------------------
    // Yardimci metotlar
    // -------------------------------------------------------------------------

    /** Delta hesapla — negatifse 0 dondur. */
    private long d(Map<String, Long> prev, Map<String, Long> current, String key) {
        Long delta = deltaCalc.deltaLong(current.getOrDefault(key, 0L),
                prev.getOrDefault(key, 0L));
        return delta != null ? delta : 0L;
    }

    private long d2l(Double val) { return val != null ? val.longValue() : 0L; }
    private double orZeroD(Double val) { return val != null ? val : 0.0; }
}
