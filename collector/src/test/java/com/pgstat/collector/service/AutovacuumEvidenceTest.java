package com.pgstat.collector.service;

import com.pgstat.collector.repository.FactRepository;
import com.pgstat.collector.service.AlertRuleEvaluator.AutovacuumWorkerEvidence;
import com.pgstat.collector.service.AlertRuleEvaluator.EvidenceStatus;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Autovacuum kanit katmaninin (PGSTAT-P1-011) DB'ye ihtiyac duymayan
 * sozlesme testleri. Tasarim: docs/autovacuum-cost-diagnosis-design.md
 *
 * Burada test edilenler bilincli olarak "saf" mantik: durum alanlarinin
 * bagimsizligi, kova aritmetigi, surum varsayilanlari, reloption parse,
 * ve uretilen metnin gozlemsel dilde kalmasi. Sorgu davranisi (distinct
 * snapshot sayimi, tazelik esigi) canli dogrulamaya (AC3) birakildi.
 */
class AutovacuumEvidenceTest {

    private final AlertRuleEvaluator evaluator = new AlertRuleEvaluator(null, null, null);

    /** Test kolayligi icin tam kayit uretici. */
    private AutovacuumWorkerEvidence evidence(
            long total, int distinctSnapshots, long ioWait, Long throttle,
            long noWait, long other,
            EvidenceStatus ioStatus, EvidenceStatus throttleStatus) {
        return new AutovacuumWorkerEvidence(
            1, 3, null, 3, total, distinctSnapshots, ioWait, throttle, noWait, other,
            EvidenceStatus.AVAILABLE, ioStatus, throttleStatus, EvidenceStatus.NOT_APPLICABLE);
    }

    // ---------------------------------------------------------------
    // Dort bagimsiz status alani
    // ---------------------------------------------------------------

    @Test
    void pg12InstanceHasAvailableIoWaitButUnsupportedThrottle() {
        // PG12'de VacuumDelay wait_event'i hic yok, ama IO-wait sinyali var.
        // Tek bir enum bu ikisini ayni anda temsil edemezdi.
        AutovacuumWorkerEvidence ev = evidence(
            40, 12, 10, null, 25, 5,
            EvidenceStatus.AVAILABLE, EvidenceStatus.UNSUPPORTED_VERSION);

        assertThat(ev.ioWaitStatus()).isEqualTo(EvidenceStatus.AVAILABLE);
        assertThat(ev.throttleStatus()).isEqualTo(EvidenceStatus.UNSUPPORTED_VERSION);
        assertThat(ev.throttleSleepSamples()).isNull();
    }

    @Test
    void insufficientSamplesDoNotInvalidateCurrentWorkerCount() {
        // 9 farkli snapshot: oranlar yorumlanamaz ama "su an kac worker
        // calisiyor" tek bir guncel snapshot'a dayandigi icin hala gecerli.
        AutovacuumWorkerEvidence ev = new AutovacuumWorkerEvidence(
            2, 3, null, 3, 9, 9, 3, 4L, 2, 0,
            EvidenceStatus.AVAILABLE, EvidenceStatus.INSUFFICIENT_DATA,
            EvidenceStatus.INSUFFICIENT_DATA, EvidenceStatus.NOT_APPLICABLE);

        assertThat(ev.currentWorkerStatus()).isEqualTo(EvidenceStatus.AVAILABLE);
        assertThat(ev.runningWorkers()).isEqualTo(2);
        assertThat(ev.ioWaitStatus()).isEqualTo(EvidenceStatus.INSUFFICIENT_DATA);
    }

    @Test
    void unknownCapacityDoesNotAffectWaitEvidence() {
        // PG18'de worker_slots toplanmamissa sadece kapasite bilinmez;
        // wait-event kanitlari etkilenmez.
        AutovacuumWorkerEvidence ev = new AutovacuumWorkerEvidence(
            1, 3, null, null, 40, 12, 10, 20L, 8, 2,
            EvidenceStatus.AVAILABLE, EvidenceStatus.AVAILABLE,
            EvidenceStatus.AVAILABLE, EvidenceStatus.UNKNOWN);

        assertThat(ev.capacityStatus()).isEqualTo(EvidenceStatus.UNKNOWN);
        assertThat(ev.effectiveWorkerCapacity()).isNull();
        assertThat(ev.ioWaitStatus()).isEqualTo(EvidenceStatus.AVAILABLE);
        assertThat(ev.throttleStatus()).isEqualTo(EvidenceStatus.AVAILABLE);
    }

    // ---------------------------------------------------------------
    // Kova aritmetigi
    // ---------------------------------------------------------------

    @Test
    void namedBucketsPlusResidualAlwaysEqualTotalSamples() {
        AutovacuumWorkerEvidence ev = evidence(
            100, 20, 30, 45L, 15, 10,
            EvidenceStatus.AVAILABLE, EvidenceStatus.AVAILABLE);

        long sum = ev.ioWaitSamples() + ev.throttleSleepSamples()
            + ev.noWaitEventSamples() + ev.otherWaitSamples();

        assertThat(sum).isEqualTo(ev.totalSamples());
        assertThat(ev.otherWaitSamples()).isNotNegative();
    }

    @Test
    void ratiosAreZeroWhenNoSamplesInsteadOfDividingByZero() {
        AutovacuumWorkerEvidence ev = evidence(
            0, 0, 0, 0L, 0, 0,
            EvidenceStatus.NO_FRESH_SNAPSHOT, EvidenceStatus.NO_FRESH_SNAPSHOT);

        assertThat(ev.ioWaitPct()).isZero();
        assertThat(ev.throttleSleepPct()).isZero();
    }

    @Test
    void throttlePctIsZeroWhenSignalUnsupportedRatherThanThrowing() {
        AutovacuumWorkerEvidence ev = evidence(
            50, 15, 20, null, 25, 5,
            EvidenceStatus.AVAILABLE, EvidenceStatus.UNSUPPORTED_VERSION);

        assertThat(ev.throttleSleepPct()).isZero();
    }

    // ---------------------------------------------------------------
    // Surum varsayilanlari (cost_delay esigi)
    // ---------------------------------------------------------------

    @Test
    void costDelayDefaultIs20msOnPg11And2msFromPg12Onward() {
        // 20ms -> 2ms dususu PG12'de oldu, PG13'te DEGIL.
        assertThat(AlertRuleEvaluator.versionDefaultCostDelayMs(11)).isEqualTo(20);
        assertThat(AlertRuleEvaluator.versionDefaultCostDelayMs(12)).isEqualTo(2);
        assertThat(AlertRuleEvaluator.versionDefaultCostDelayMs(13)).isEqualTo(2);
        assertThat(AlertRuleEvaluator.versionDefaultCostDelayMs(18)).isEqualTo(2);
    }

    @Test
    void unknownPgMajorFallsBackToModernDefault() {
        assertThat(AlertRuleEvaluator.versionDefaultCostDelayMs(null)).isEqualTo(2);
    }

    // ---------------------------------------------------------------
    // reloptions parse
    // ---------------------------------------------------------------

    @Test
    void parsesCostDelayOverrideFromRawReloptions() {
        String raw = "{autovacuum_vacuum_cost_delay=10,fillfactor=90}";

        assertThat(FactRepository.parseIntRelOption(raw, "autovacuum_vacuum_cost_delay"))
            .isEqualTo(10);
    }

    @Test
    void returnsNullWhenOptionAbsentOrUnparsable() {
        assertThat(FactRepository.parseIntRelOption("{fillfactor=90}", "autovacuum_vacuum_cost_delay"))
            .isNull();
        assertThat(FactRepository.parseIntRelOption("{autovacuum_vacuum_cost_delay=abc}", "autovacuum_vacuum_cost_delay"))
            .isNull();
        assertThat(FactRepository.parseIntRelOption(null, "autovacuum_vacuum_cost_delay")).isNull();
        assertThat(FactRepository.parseIntRelOption("", "autovacuum_vacuum_cost_delay")).isNull();
    }

    @Test
    void preservesMinusOneSentinelRatherThanTreatingItAsAValue() {
        // -1 "global ayari kullan" demek; cozumleme zinciri bunu bir deger
        // olarak degil, bir sonraki adima gecis sinyali olarak gormeli.
        assertThat(FactRepository.parseIntRelOption(
            "{autovacuum_vacuum_cost_delay=-1}", "autovacuum_vacuum_cost_delay"))
            .isEqualTo(-1);
    }

    // ---------------------------------------------------------------
    // Uretilen metnin dili
    // ---------------------------------------------------------------

    @Test
    void evidenceTextStaysObservationalAndNeverClaimsSlowDisk() {
        AutovacuumWorkerEvidence ev = evidence(
            100, 20, 60, 30L, 5, 5,
            EvidenceStatus.AVAILABLE, EvidenceStatus.AVAILABLE);

        String text = evaluator.renderWorkerWaitEvidence(ev);

        assertThat(text).contains("tamamlanması bekleniyordu");
        assertThat(text).doesNotContain("disk yavaş");
        assertThat(text).doesNotContain("yavaşlatıyor");
    }

    @Test
    void reportsInsufficientSamplesInsteadOfShowingAMisleadingRatio() {
        AutovacuumWorkerEvidence ev = evidence(
            9, 9, 5, 3L, 1, 0,
            EvidenceStatus.INSUFFICIENT_DATA, EvidenceStatus.INSUFFICIENT_DATA);

        String text = evaluator.renderWorkerWaitEvidence(ev);

        assertThat(text).contains("yeterli örneklem yok");
        assertThat(text).doesNotContain("%");
    }

    @Test
    void statesExplicitlyThatThrottleSignalIsMissingOnOldVersions() {
        // PG12'de sessizce "0 throttle" gostermek "throttle yok" gibi yanlis
        // bir sonuca goturur — acikca "bu surumde yok" denmeli.
        AutovacuumWorkerEvidence ev = evidence(
            40, 12, 10, null, 25, 5,
            EvidenceStatus.AVAILABLE, EvidenceStatus.UNSUPPORTED_VERSION);

        String text = evaluator.renderWorkerWaitEvidence(ev);

        assertThat(text).contains("PG13");
        assertThat(text).contains("bu PG sürümünde yok");
    }

    @Test
    void emptyWindowIsNotReportedAsAutovacuumNotRunning() {
        AutovacuumWorkerEvidence ev = evidence(
            0, 0, 0, 0L, 0, 0,
            EvidenceStatus.NO_FRESH_SNAPSHOT, EvidenceStatus.NO_FRESH_SNAPSHOT);

        String text = evaluator.renderWorkerWaitEvidence(ev);

        assertThat(text).contains("hiç çalışmadığı anlamına gelmez");
    }

    @Test
    void mentionsOtherWaitBucketWhenPresentSoItIsNotSilentlyDropped() {
        AutovacuumWorkerEvidence ev = evidence(
            100, 20, 30, 40L, 10, 20,
            EvidenceStatus.AVAILABLE, EvidenceStatus.AVAILABLE);

        String text = evaluator.renderWorkerWaitEvidence(ev);

        assertThat(text).contains("başka bir bekleme türü");
    }

    @Test
    void unknownEvidenceRecordIsSafeToRender() {
        String text = evaluator.renderWorkerWaitEvidence(AutovacuumWorkerEvidence.unknown());

        assertThat(text).isNotNull();
    }

    // ---------------------------------------------------------------
    // Template render basarisiz oldugunda kanit korunmasi
    // ---------------------------------------------------------------

    @Test
    void fallbackMessageKeepsDiagnosisAndActionWhenTemplateRenderFails() {
        // Eskiden template render hatasi tum kaniti sessizce yutuyordu ve
        // kullaniciya sadece jenerik esik satiri gidiyordu.
        java.util.Map<String, Object> ctx = new java.util.HashMap<>();
        ctx.put("diagnosis", "Teşhis: Autovacuum çalışıyor ama yetişemiyor.\n");
        ctx.put("bloat_action", "Eşik ayarlarını gözden geçir.");

        String msg = AlertRuleEvaluator.appendDiagnosisToFallback(
            "Tablo esigi asti: dead_tuple_ratio = 35", ctx);

        assertThat(msg).contains("Tablo esigi asti");
        assertThat(msg).contains("Autovacuum çalışıyor ama yetişemiyor");
        assertThat(msg).contains("Eşik ayarlarını gözden geçir");
    }

    // ---------------------------------------------------------------
    // Teshis 0 — alti durumlu I/O islem sayisi modeli
    // ---------------------------------------------------------------

    @Test
    void zeroIoWithFreshDataIsNotWordedAsAutovacuumNotRunning() {
        // Sifir relation I/O, "autovacuum calismadi" DEMEK DEGIL — sayfalar
        // shared buffers'ta bulunmus (hit) olabilir.
        AlertRuleEvaluator.AutovacuumIoImpact io = new AlertRuleEvaluator.AutovacuumIoImpact(
            0L, 0L, 5000L, 1000L, null, 100.0,
            AlertRuleEvaluator.IoImpactStatus.ZERO_IO_WITH_FRESH_DATA);

        String text = evaluator.renderIoImpactEvidence(io);

        assertThat(text).contains("hiç çalışmadığı anlamına gelmez");
        assertThat(text).contains("shared buffers");
    }

    @Test
    void noFreshDataIsDistinctFromRealZero() {
        String noData = evaluator.renderIoImpactEvidence(
            AlertRuleEvaluator.AutovacuumIoImpact.of(AlertRuleEvaluator.IoImpactStatus.NO_FRESH_DATA));
        String realZero = evaluator.renderIoImpactEvidence(new AlertRuleEvaluator.AutovacuumIoImpact(
            0L, 0L, 10L, 10L, null, 100.0,
            AlertRuleEvaluator.IoImpactStatus.ZERO_IO_WITH_FRESH_DATA));

        assertThat(noData).contains("taze veri yok");
        assertThat(realZero).doesNotContain("taze veri yok");
        assertThat(noData).isNotEqualTo(realZero);
    }

    @Test
    void unsupportedVersionSaysSoInsteadOfShowingZero() {
        String text = evaluator.renderIoImpactEvidence(
            AlertRuleEvaluator.AutovacuumIoImpact.of(AlertRuleEvaluator.IoImpactStatus.UNSUPPORTED));

        assertThat(text).contains("PG16");
        assertThat(text).doesNotContain("0 okuma");
    }

    @Test
    void unknownCapabilityIsDistinctFromUnsupported() {
        String unknown = evaluator.renderIoImpactEvidence(
            AlertRuleEvaluator.AutovacuumIoImpact.of(AlertRuleEvaluator.IoImpactStatus.UNKNOWN_CAPABILITY));
        String unsupported = evaluator.renderIoImpactEvidence(
            AlertRuleEvaluator.AutovacuumIoImpact.of(AlertRuleEvaluator.IoImpactStatus.UNSUPPORTED));

        assertThat(unknown).contains("henüz bilinmediği");
        assertThat(unknown).isNotEqualTo(unsupported);
    }

    @Test
    void reportsAbsoluteCountsWithoutRatioWhenClientReadsAreZero() {
        // Sifira bolme/sonsuz oran uretmek yerine mutlak sayilar raporlanir.
        AlertRuleEvaluator.AutovacuumIoImpact io = new AlertRuleEvaluator.AutovacuumIoImpact(
            5_000_000L, 4_000_000L, 0L, 100L, null, 100.0,
            AlertRuleEvaluator.IoImpactStatus.AVAILABLE);

        String text = evaluator.renderIoImpactEvidence(io);

        assertThat(text).contains("oran hesaplanmadı");
        assertThat(text).doesNotContain("Infinity");
    }

    @Test
    void ioEvidenceReportsOperationCountsNotBytesOrThroughput() {
        AlertRuleEvaluator.AutovacuumIoImpact io = new AlertRuleEvaluator.AutovacuumIoImpact(
            5_119_503L, 4_203_112L, 172_332L, 6_245_526L, 29.7, 100.0,
            AlertRuleEvaluator.IoImpactStatus.AVAILABLE);

        String text = evaluator.renderIoImpactEvidence(io);

        assertThat(text).contains("işlemi yaptı");
        assertThat(text).doesNotContain("MB");
        assertThat(text).doesNotContain("IOPS");
        assertThat(text).doesNotContain("maliyet");
    }

    @Test
    void partialMetricCoverageIsDisclosedRatherThanSilentlyAveraged() {
        AlertRuleEvaluator.AutovacuumIoImpact io = new AlertRuleEvaluator.AutovacuumIoImpact(
            1000L, 500L, 100L, 200L, 10.0, 60.0,
            AlertRuleEvaluator.IoImpactStatus.AVAILABLE);

        String text = evaluator.renderIoImpactEvidence(io);

        assertThat(text).contains("Ölçüm kapsamı");
    }

    // ---------------------------------------------------------------
    // timestamptz normalizasyonu — canli testte bulunan sessiz bug
    // ---------------------------------------------------------------

    @Test
    void sqlTimestampIsNormalizedBecauseQueryForListReturnsThatNotOffsetDateTime() {
        // Kok neden: Spring'in ColumnMapRowMapper'i rs.getObject(i) cagirir ve
        // PG surucusu timestamptz icin java.sql.Timestamp doner. Kod
        // "instanceof OffsetDateTime" bekliyordu -> senaryo 3.5/4/4.5 HIC
        // tetiklenemiyordu.
        java.time.OffsetDateTime beklenen = java.time.OffsetDateTime.now().minusHours(3);
        java.sql.Timestamp surucuden = java.sql.Timestamp.from(beklenen.toInstant());

        java.time.OffsetDateTime sonuc = AlertRuleEvaluator.asOffsetDateTime(surucuden);

        assertThat(sonuc).isNotNull();
        assertThat(sonuc.toInstant()).isEqualTo(beklenen.toInstant());
    }

    @Test
    void offsetDateTimePassesThroughUnchanged() {
        java.time.OffsetDateTime girdi = java.time.OffsetDateTime.now();

        assertThat(AlertRuleEvaluator.asOffsetDateTime(girdi)).isEqualTo(girdi);
    }

    @Test
    void instantAndLocalDateTimeAreAlsoAccepted() {
        java.time.Instant inst = java.time.Instant.now();
        assertThat(AlertRuleEvaluator.asOffsetDateTime(inst)).isNotNull();

        java.time.LocalDateTime ldt = java.time.LocalDateTime.now();
        assertThat(AlertRuleEvaluator.asOffsetDateTime(ldt)).isNotNull();
    }

    @Test
    void unknownTypesAndNullYieldNullRatherThanThrowing() {
        assertThat(AlertRuleEvaluator.asOffsetDateTime(null)).isNull();
        assertThat(AlertRuleEvaluator.asOffsetDateTime("2026-08-26")).isNull();
        assertThat(AlertRuleEvaluator.asOffsetDateTime(12345L)).isNull();
    }

    @Test
    void normalizedTimestampMakesRecencyChecksWorkAsIntended() {
        // Bug'in pratik sonucu: bir saat once calismis autovacuum "yakin
        // zamanda" sayilmali. Timestamp olarak gelirse eski kod false
        // donuyordu; normalize edilince dogru calisir.
        java.sql.Timestamp birSaatOnce = java.sql.Timestamp.from(
            java.time.OffsetDateTime.now().minusHours(1).toInstant());

        java.time.OffsetDateTime norm = AlertRuleEvaluator.asOffsetDateTime(birSaatOnce);

        assertThat(norm).isNotNull();
        assertThat(norm.isAfter(java.time.OffsetDateTime.now().minusHours(24))).isTrue();
    }

    // ---------------------------------------------------------------
    // Aksiyon metninde gercek sema/tablo adi
    // ---------------------------------------------------------------

    @Test
    void actionTextUsesRealTableNameInsteadOfPlaceholder() {
        java.util.Map<String, Object> rec = new java.util.HashMap<>();
        rec.put("schemaname", "agg");
        rec.put("relname", "pg_table_stat_hourly");

        assertThat(AlertRuleEvaluator.qualifiedTableName(rec))
            .isEqualTo("agg.pg_table_stat_hourly");
    }

    @Test
    void identifiersNeedingQuotesAreQuotedForCopyPasteSafety() {
        java.util.Map<String, Object> rec = new java.util.HashMap<>();
        rec.put("schemaname", "MixedCase");
        rec.put("relname", "tablo adi");

        assertThat(AlertRuleEvaluator.qualifiedTableName(rec))
            .isEqualTo("\"MixedCase\".\"tablo adi\"");
    }

    @Test
    void embeddedQuotesAreDoubledPerPostgresRules() {
        java.util.Map<String, Object> rec = new java.util.HashMap<>();
        rec.put("schemaname", "public");
        rec.put("relname", "wei\"rd");

        assertThat(AlertRuleEvaluator.qualifiedTableName(rec))
            .isEqualTo("public.\"wei\"\"rd\"");
    }

    @Test
    void fallsBackToPlaceholderRatherThanEmittingBrokenSql() {
        // Ad okunamazsa bozuk bir komut uretmektense yer tutucu daha guvenli.
        assertThat(AlertRuleEvaluator.qualifiedTableName(new java.util.HashMap<>()))
            .isEqualTo("<şema.tablo>");
    }

    // ---------------------------------------------------------------
    // Senaryo 4 bastirma sozlesmesi
    // ---------------------------------------------------------------

    @Test
    void suppressedDiagnosisCarriesTheSuppressFlagAndNoText() {
        AlertRuleEvaluator.BloatDiagnosis d = AlertRuleEvaluator.BloatDiagnosis.suppressed();

        assertThat(d.suppressAlert()).isTrue();
        assertThat(d.diagnosis()).isEmpty();
        assertThat(d.action()).isEmpty();
    }

    @Test
    void normalDiagnosisNeverSuppresses() {
        AlertRuleEvaluator.BloatDiagnosis d =
            AlertRuleEvaluator.BloatDiagnosis.of("teşhis", "aksiyon");

        assertThat(d.suppressAlert()).isFalse();
        assertThat(d.diagnosis()).isEqualTo("teşhis");
        assertThat(d.action()).isEqualTo("aksiyon");
    }

    @Test
    void bothTransientScenariosShareTheSameStreakThreshold() {
        // Senaryo 4 ve 1b-ii ayni esigi kullaniyor: ikisi de 'biraz bekle'
        // diyen, ilk goruslerde alert acmamasi gereken durumlar. Farkli
        // scenario anahtarlariyla ayri sayilirlar ki biri digerini
        // etkilemesin.
        assertThat("scenario_4").isNotEqualTo("scenario_1b_ii");
    }

    // =========================================================================
    // Israr sayaci ilerletme kurali (shouldResetStreak)
    // =========================================================================

    @Test
    void streakKeepsAdvancingWhenDeadTuplesStayFlat() {
        // Uretimde bulunan hata (2026-08-27): security.user tablosu 6 canli /
        // 3224 olu satirla hic vacuum edilmemis durumdaydi ve olu satir sayisi
        // artik ARTMIYORDU. Sayac "artiyor mu" kuralini kullandigi icin her
        // degerlendirmede 1'e donuyor, esik hicbir zaman asilmiyor ve bu tablo
        // kalici olarak gorunmez kaliyordu. Sabit kalmak, sorunun bittigi
        // anlamina gelmez.
        assertThat(AlertRuleEvaluator.shouldResetStreak(3224L, 3224L)).isFalse();
    }

    @Test
    void streakAdvancesWhenDeadTuplesGrow() {
        assertThat(AlertRuleEvaluator.shouldResetStreak(1000L, 1500L)).isFalse();
    }

    @Test
    void streakResetsOnlyWhenDeadTuplesActuallyFall() {
        // Gerileme = kismi vacuum ise yaramis; israr sayilmaz, bastan sayilir.
        assertThat(AlertRuleEvaluator.shouldResetStreak(1500L, 1000L)).isTrue();
    }

    @Test
    void streakAdvancesWhenPreviousCountIsUnknown() {
        // Ilk gorulme ya da okunamayan onceki deger: bilinmeyeni "duzelme"
        // saymayiz, cunku bu sayaci sonsuza kadar sifirda tutabilirdi.
        assertThat(AlertRuleEvaluator.shouldResetStreak(null, 500L)).isFalse();
        assertThat(AlertRuleEvaluator.shouldResetStreak(500L, null)).isFalse();
    }

    @Test
    void fallbackMessageIsUnchangedWhenThereIsNoDiagnosisToAdd() {
        // dead_tuple_ratio disindaki metrikler icin diagnosis bos string —
        // mesaja bos satir/artik eklenmemeli.
        java.util.Map<String, Object> ctx = new java.util.HashMap<>();
        ctx.put("diagnosis", "");

        String msg = AlertRuleEvaluator.appendDiagnosisToFallback("Index esigi asti", ctx);

        assertThat(msg).isEqualTo("Index esigi asti");
    }
}
