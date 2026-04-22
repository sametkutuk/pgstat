package com.pgstat.collector.service;

import com.pgstat.collector.sql.*;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.Map;

/**
 * pg_major degerine gore uygun SourceQueries implementasyonunu secer.
 *
 * Eslesme tablosu:
 *   PG11, PG12 → pg11_12
 *   PG13       → pg13
 *   PG14-PG16  → pg14_16
 *   PG17-PG18  → pg17_18
 *
 * Bilinmeyen versiyon icin en yakin ust aile secilir.
 * Tamamen desteklenmeyen surumlerde null donebilir.
 */
@Service
public class SqlFamilyResolver {

    private static final Logger log = LoggerFactory.getLogger(SqlFamilyResolver.class);

    /** Singleton SourceQueries instance'lari — stateless oldukları icin paylasim guvenli */
    private static final Map<String, SourceQueries> FAMILIES = Map.of(
        "pg11_12", new Pg11_12Queries(),
        "pg13",    new Pg13Queries(),
        "pg14_16", new Pg14_16Queries(),
        "pg17_18", new Pg17_18Queries()
    );

    /**
     * pg_major degerinden collector_sql_family kodunu belirler.
     *
     * @param pgMajor PostgreSQL major versiyon numarasi (11, 12, ..., 18)
     * @return family kodu (ornek: "pg14_16")
     */
    public String resolveFamilyCode(int pgMajor) {
        if (pgMajor <= 12) return "pg11_12";
        if (pgMajor == 13) return "pg13";
        if (pgMajor <= 16) return "pg14_16";
        if (pgMajor <= 18) return "pg17_18";

        // Gelecekteki PG19+ icin en yakin ust aile
        log.warn("Bilinmeyen PG major {}, pg17_18 family kullaniliyor", pgMajor);
        return "pg17_18";
    }

    /**
     * pg_major degerinden SourceQueries implementasyonunu dondurur.
     *
     * @param pgMajor PostgreSQL major versiyon numarasi
     * @return uygun SourceQueries implementasyonu
     */
    public SourceQueries resolve(int pgMajor) {
        String familyCode = resolveFamilyCode(pgMajor);
        return FAMILIES.get(familyCode);
    }

    /**
     * Family kodundan SourceQueries implementasyonunu dondurur.
     * instance_capability'den okunan kayitli family kodu ile kullanilir.
     *
     * @param familyCode kayitli family kodu (ornek: "pg14_16")
     * @return uygun SourceQueries implementasyonu, bulunamazsa null
     */
    public SourceQueries resolveByCode(String familyCode) {
        SourceQueries queries = FAMILIES.get(familyCode);
        if (queries == null) {
            log.warn("Bilinmeyen SQL family kodu: {}", familyCode);
        }
        return queries;
    }

    /**
     * server_version_num degerinden pg_major cikarir.
     * Ornek: 170001 → 17, 140010 → 14, 110005 → 11
     */
    public static int extractPgMajor(int serverVersionNum) {
        return serverVersionNum / 10000;
    }
}
