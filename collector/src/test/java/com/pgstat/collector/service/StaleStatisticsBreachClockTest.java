package com.pgstat.collector.service;

import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Bayat istatistik kuralinin KIDEM SAATI (PGSTAT-P0-048 AC5).
 *
 * Eskiden severity stale_hours'tan hesaplaniyordu: son ANALYZE'dan bu yana
 * gecen sure. Bu YANLIS SAAT. 178 saat once analiz edilmis ama autoanalyze
 * esigini bir saat once gecmis bir tablo 178 saat rapor edip dogrudan
 * CRITICAL'a gidiyordu — oysa sorun bir saatlik.
 *
 * Ikisi farkli saatler ve yalnizca biri aciliyet soyluyor. Kidem artik
 * epizodun first_observed_breaching_at damgasindan geliyor; son ANALYZE
 * baglam olarak mesajda kaliyor.
 */
class StaleStatisticsBreachClockTest {

    @Test
    void anUnstampedBreachIsZeroHoursOldNotInfinite() {
        // Epizot bu turda yeni acildiysa damga henuz okunamayabilir. Null'i
        // "sonsuzdur bayat" saymak, ilk gorulen ihlali ANINDA critical
        // yapardi — duzeltmeye calistigimiz hatanin aynisi, ters yonden.
        assertThat(AlertRuleEvaluator.hoursSince(null)).isZero();
    }

    @Test
    void theClockCountsFromTheBreachNotFromNow() {
        double h = AlertRuleEvaluator.hoursSince(Instant.now().minusSeconds(6 * 3600));
        assertThat(h).isCloseTo(6.0, org.assertj.core.data.Offset.offset(0.05));
    }

    @Test
    void aFutureStampNeverProducesNegativeSeniority() {
        // Saat kaymasi ya da ileri tarihli bir damga negatif kidem uretmemeli;
        // negatif bir sayi esik karsilastirmasinda sessizce "hic bayat degil"
        // anlamina gelir ve gercek bir ihlali gizlerdi.
        assertThat(AlertRuleEvaluator.hoursSince(Instant.now().plusSeconds(3600))).isZero();
    }

    @Test
    void eachStaleTableGetsItsOwnIdentityRatherThanOnePerInstance() {
        // Kural instance basina TEK anahtar kullaniyordu
        // ("rule:14:instance:2"), yani bir instance'ta yalnizca tek bir bayat
        // alarm olabiliyordu ve tablolar birbirini bastiriyordu. Granular
        // kurallar bunu 2026-08-28'de cozmustu; stale_statistics o
        // duzeltmenin disinda kalmisti.
        Map<String, Object> a = Map.of("dbid", 16388L, "relid", 7887268L,
            "schemaname", "public", "relname", "t_order");
        Map<String, Object> b = Map.of("dbid", 21169L, "relid", 7887268L,
            "schemaname", "public", "relname", "t_order");

        String keyA = AlertRuleEvaluator.recordAlertKey(14, 2, a, "table_metric");
        String keyB = AlertRuleEvaluator.recordAlertKey(14, 2, b, "table_metric");

        // AYNI relid, FARKLI veritabani -> ayri kimlik. relid tek basina
        // benzersiz degil; instance 18'de relid 7887268 iki ayri dbid'de var.
        assertThat(keyA).isNotEqualTo(keyB);
        assertThat(keyA).startsWith(AlertRuleEvaluator.recordAlertKeyPrefix(14, 2));
        assertThat(keyA).contains("db:16388").contains("rel:7887268");
    }

    @Test
    void tablesWithoutAnOidStillGetDistinctKeys() {
        // relid secmeyen sorgular icin sema.ad'a duser; yine de tablolar
        // birbirine karismamali.
        Map<String, Object> a = Map.of("dbid", 16388L, "schemaname", "public", "relname", "t_order");
        Map<String, Object> b = Map.of("dbid", 16388L, "schemaname", "engine", "relname", "t_order");

        assertThat(AlertRuleEvaluator.recordAlertKey(14, 2, a, "table_metric"))
            .isNotEqualTo(AlertRuleEvaluator.recordAlertKey(14, 2, b, "table_metric"));
    }
}
