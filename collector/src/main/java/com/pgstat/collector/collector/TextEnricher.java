package com.pgstat.collector.collector;

import com.pgstat.collector.model.InstanceInfo;
import com.pgstat.collector.repository.CapabilityRepository;
import com.pgstat.collector.repository.DimensionRepository;
import com.pgstat.collector.service.SqlFamilyResolver;
import com.pgstat.collector.service.SourceConnectionFactory;
import com.pgstat.collector.sql.SourceQueries;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.security.MessageDigest;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * SQL text enrichment — query_text_id'si NULL olan statement_series icin
 * kaynak PG'den SQL text'i ceker ve dim.query_text tablosuna yazar.
 *
 * Calisma mantigi:
 * 1. dim.statement_series'te query_text_id = NULL olan satirlari bul
 * 2. Kaynak PG'den pg_stat_statements(true) ile SQL text'leri cek
 * 3. query_hash olustur (SHA-256 hex)
 * 4. dim.query_text upsert → query_text_id al
 * 5. dim.statement_series.query_text_id guncelle
 *
 * Batch boyutu: schedule_profile.bootstrap_sql_text_batch ile sinirlanir.
 */
@Component
public class TextEnricher {

    private static final Logger log = LoggerFactory.getLogger(TextEnricher.class);

    private final SourceConnectionFactory connectionFactory;
    private final SqlFamilyResolver familyResolver;
    private final CapabilityRepository capabilityRepo;
    private final DimensionRepository dimensionRepo;

    public TextEnricher(SourceConnectionFactory connectionFactory,
                        SqlFamilyResolver familyResolver,
                        CapabilityRepository capabilityRepo,
                        DimensionRepository dimensionRepo) {
        this.connectionFactory = connectionFactory;
        this.familyResolver = familyResolver;
        this.capabilityRepo = capabilityRepo;
        this.dimensionRepo = dimensionRepo;
    }

    /**
     * Text enrichment calistirir.
     *
     * @param instance hedef instance
     * @param batchSize tek seferde islenecek maksimum seri sayisi
     * @return yeni query_text sayisi
     */
    public int enrich(InstanceInfo instance, int batchSize) throws Exception {
        long instancePk = instance.instancePk();

        // Enrichment bekleyen seriler
        List<long[]> pendingSeries = dimensionRepo.findSeriesWithoutQueryText(instancePk, batchSize);
        if (pendingSeries.isEmpty()) {
            return 0;
        }

        log.debug("Text enrichment baslatiliyor: {} — {} seri bekliyor",
                instance.instanceId(), pendingSeries.size());

        // queryid → seriesId map
        Map<Long, Long> queryIdToSeriesId = new HashMap<>();
        for (long[] pair : pendingSeries) {
            queryIdToSeriesId.put(pair[1], pair[0]); // [seriesId, queryId]
        }

        // Kaynak PG'den SQL text'leri cek
        String sqlFamily = capabilityRepo.findSqlFamily(instancePk);
        Integer pgMajor = capabilityRepo.findPgMajor(instancePk);
        SourceQueries queries = familyResolver.resolveByCode(sqlFamily);
        int enrichedCount = 0;

        try (Connection conn = connectionFactory.connect(instance);
             Statement stmt = conn.createStatement();
             ResultSet rs = stmt.executeQuery(queries.pgssTextQuery())) {

            while (rs.next()) {
                long queryid = rs.getLong("queryid");
                String queryText = rs.getString("query");

                // Bu queryid'nin enrichment bekleyen serisi var mi?
                Long seriesId = queryIdToSeriesId.get(queryid);
                if (seriesId == null || queryText == null || queryText.isBlank()) {
                    continue;
                }

                // query_hash olustur (SHA-256, byte[])
                byte[] queryHash = hashQuery(queryText);

                // dim.query_text upsert
                long queryTextId = dimensionRepo.upsertQueryText(
                    queryHash, queryText, instancePk, pgMajor);

                // dim.statement_series.query_text_id guncelle
                dimensionRepo.updateSeriesQueryTextId(seriesId, queryTextId);

                enrichedCount++;
                queryIdToSeriesId.remove(queryid); // Islendi, tekrar islenmesin
            }
        }

        log.info("Text enrichment tamamlandi: {} — {}/{} seri zenginlestirildi",
                instance.instanceId(), enrichedCount, pendingSeries.size());

        return enrichedCount;
    }

    /** SQL text'in SHA-256 hash'ini byte[] olarak uretir (bytea kolonu icin). */
    static byte[] hashQuery(String queryText) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            return md.digest(queryText.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        } catch (Exception e) {
            // SHA-256 her JVM'de mevcut; bu noktaya ulasilmamali
            throw new RuntimeException("SHA-256 hash olusturulamadi", e);
        }
    }
}
