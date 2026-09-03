package com.pgstat.collector.repository;

import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * GOLGE YAZIM HATASI ANA ALARM AKISINI DURDURMAZ (PGSTAT-P0-048 AC10, AC12).
 *
 * Dis inceleme bunu deploy sarti koydu ve hakliydi. Yeni bir yazma ekliyoruz;
 * o yazma patladiginda alarm uretiminin devam ettigini KANITLAMADAN deploy
 * etmek, bu haftanin ucuncu kez tekrarlanan hatasinin dordunculeri olurdu.
 */
class AlertEpisodeShadowFailureTest {

    private static AlertEpisodeRepository.Observation sampleObservation() {
        return new AlertEpisodeRepository.Observation(
            "rule:1:instance:2", "user_defined_rule", "user_rule", 2L,
            null, null, null, false,
            AlertEpisodeRepository.STATE_BREACHING, "warning", Instant.now());
    }

    @Test
    void observeSwallowsDatabaseFailures() {
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        when(jdbc.update(anyString(), any(Object[].class)))
            .thenThrow(new DataAccessResourceFailureException("epizot tablosu yok"));

        AlertEpisodeRepository episodes = new AlertEpisodeRepository(jdbc);

        assertThatCode(() -> episodes.observe(sampleObservation()))
            .doesNotThrowAnyException();
    }

    @Test
    void aSwallowedFailureIsStillCounted() {
        // Yutulan hata SESSIZ OLMAMALI. Bu hafta iki ayri hata tam da
        // gorunmez yutuldugu icin haftalarca fark edilmedi: izleme yolu 14
        // saat boyunca hicbir satir yazmadi ve kimse anlamadi. Sayac, ayni
        // seyin epizot tarafinda olmasini engelliyor.
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        when(jdbc.update(anyString(), any(Object[].class)))
            .thenThrow(new DataAccessResourceFailureException("baglanti koptu"));

        AlertEpisodeRepository episodes = new AlertEpisodeRepository(jdbc);
        assertThat(episodes.getWriteFailures()).isZero();

        episodes.observe(sampleObservation());
        episodes.observe(sampleObservation());

        assertThat(episodes.getWriteFailures()).isEqualTo(2);
        assertThat(episodes.getLastFailureMessage()).contains("baglanti koptu");
        assertThat(episodes.getLastFailureAt()).isNotNull();
    }

    @Test
    void closeSwallowsDatabaseFailures() {
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        when(jdbc.update(anyString(), any(Object[].class)))
            .thenThrow(new DataAccessResourceFailureException("kapatma basarisiz"));

        AlertEpisodeRepository episodes = new AlertEpisodeRepository(jdbc);

        assertThatCode(() -> episodes.close("rule:1:instance:2",
            AlertEpisodeRepository.CLOSE_RESOLVED)).doesNotThrowAnyException();
        assertThat(episodes.getWriteFailures()).isEqualTo(1);
    }

    @Test
    void severityPatchSwallowsDatabaseFailures() {
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        when(jdbc.update(anyString(), any(Object[].class)))
            .thenThrow(new DataAccessResourceFailureException("severity yazilamadi"));

        AlertEpisodeRepository episodes = new AlertEpisodeRepository(jdbc);

        assertThatCode(() -> episodes.observeSeverity("rule:1:instance:2", "critical"))
            .doesNotThrowAnyException();
        assertThat(episodes.getWriteFailures()).isEqualTo(1);
    }

    @Test
    void missingPhysicalIdentityOpensNoEpisodeAndIsCounted() {
        // Kimlik beklenip gelmediyse epizot ACILMAZ (AC5). Uydurulmus kimlikle
        // acilan bir epizot, gercek kimlik sonradan geldiginde cakisir ve iki
        // ayri ihlali birbirine karistirir. Sessizce atlamak da olmaz — bu
        // yuzden sayiliyor.
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        AlertEpisodeRepository episodes = new AlertEpisodeRepository(jdbc);

        episodes.observe(new AlertEpisodeRepository.Observation(
            "bloat:13:16388:7887268", "table_space_bloat", "user_rule", 13L,
            16388L, 7887268L, null, /* expectsGeneration */ true,
            AlertEpisodeRepository.STATE_BREACHING, "warning", Instant.now()));

        assertThat(episodes.getMissingIdentityCount()).isEqualTo(1);
        assertThat(episodes.getWriteFailures()).isZero();
        // Hicbir SQL calismadi: epizot acilmadi.
        org.mockito.Mockito.verifyNoInteractions(jdbc);
    }

    @Test
    void aHealthyObservationClosesTheEpisodeAndRecordsTheState() {
        // Once yalnizca closed_at/close_reason yaziliyordu ve satirin state'i
        // 'confirmed_breaching' olarak kaliyordu: kapali bir epizot, kapandigi
        // anda kosulun DOGRU oldugunu soyluyordu (inceleme 2026-09-03).
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        AlertEpisodeRepository episodes = new AlertEpisodeRepository(jdbc);

        episodes.observe(new AlertEpisodeRepository.Observation(
            "rule:1:instance:2", "user_defined_rule", "user_rule", 2L,
            null, null, null, false,
            AlertEpisodeRepository.STATE_HEALTHY, "warning", Instant.now()));

        org.mockito.ArgumentCaptor<Object[]> args =
            org.mockito.ArgumentCaptor.forClass(Object[].class);
        org.mockito.Mockito.verify(jdbc).update(
            org.mockito.ArgumentMatchers.contains("update ops.alert_episode"),
            args.capture());

        // (close_reason, finalState, alertKey)
        assertThat(args.getValue()).containsExactly(
            AlertEpisodeRepository.CLOSE_RESOLVED,
            AlertEpisodeRepository.STATE_HEALTHY,
            "rule:1:instance:2");
    }

    @Test
    void anUnverifiedCloseDoesNotClaimTheConditionCleared() {
        // Zaman asimi ve kimlik degisimi kapanislarinda kosul hakkinda hicbir
        // sey ogrenmedik. Bunlari 'confirmed_healthy' diye kaydetmek, veri
        // yoklugunu saglik kaniti saymak olurdu — bu tasarimin onlemeye
        // calistigi seyin ta kendisi.
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        AlertEpisodeRepository episodes = new AlertEpisodeRepository(jdbc);

        episodes.close("rule:1:instance:2", AlertEpisodeRepository.CLOSE_STALE_TIMEOUT);

        org.mockito.ArgumentCaptor<Object[]> args =
            org.mockito.ArgumentCaptor.forClass(Object[].class);
        org.mockito.Mockito.verify(jdbc).update(anyString(), args.capture());

        assertThat(args.getValue()[0]).isEqualTo(AlertEpisodeRepository.CLOSE_STALE_TIMEOUT);
        assertThat(args.getValue()[1]).isNull();  // state korunur
    }

    @Test
    void theMainAlertPathSurvivesAFailingEpisodeWrite() {
        // Asil kanit: epizot tarafi tamamen coktugunde bile alert satiri
        // yazilir ve alert_id doner. Alarm uretimi golge yazimin basarisina
        // bagli OLAMAZ.
        JdbcTemplate episodeJdbc = mock(JdbcTemplate.class);
        when(episodeJdbc.update(anyString(), any(Object[].class)))
            .thenThrow(new DataAccessResourceFailureException("epizot tablosu dusuruldu"));
        AlertEpisodeRepository episodes = new AlertEpisodeRepository(episodeJdbc);

        JdbcTemplate alertJdbc = mock(JdbcTemplate.class);
        when(alertJdbc.queryForObject(anyString(), org.mockito.ArgumentMatchers.eq(Long.class),
                any(Object[].class)))
            .thenReturn(4242L);

        AlertRepository alerts = new AlertRepository(alertJdbc, episodes);

        long alertId = alerts.upsertWithSeverity(
            "rule:176:instance:13", com.pgstat.collector.model.AlertCode.USER_DEFINED_RULE,
            "critical", 13L, /* serviceGroup */ null, "Baslik", "Mesaj");

        assertThat(alertId).isEqualTo(4242L);
        assertThat(episodes.getWriteFailures()).isEqualTo(1);
    }
}
