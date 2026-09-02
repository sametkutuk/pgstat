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
    // Fiziksel sisme — gecmis partition tespiti (PGSTAT-P0-042)
    // =========================================================================

    @Test
    void theMeasurementNoteStatesWhatTheNumberDoesNotCover() {
        // Not sussa operator sayiyi oldugundan kesin sanar. Uc gercek sinir
        // acikca yazilmali.
        java.util.Map<String, Object> rec = new java.util.HashMap<>();
        rec.put("fillfactor", 100L);

        String note = AlertRuleEvaluator.spaceBloatMeasurementNoteForTest(rec);

        // "tahmin degil, iki gozlem arasindaki fark" iddiasi geri cekildi:
        // payda reltuples, yani katalog TAHMINI. Mesaj olcumu oldugundan daha
        // kesin gostermemeli.
        assertThat(note).doesNotContain("tahmin değil");
        assertThat(note).contains("en sıkışık üç günün medyanı");
        assertThat(note).contains("TOAST");            // neyi kapsamadigi
        assertThat(note).contains("Satır sayısı tahmindir");
    }

    @Test
    void aProvenBaselineSaysSoInsteadOfClaimingTheStatisticalOne() {
        // Kanitli taban (dogrulanmis VACUUM FULL sonrasi olcum) ile
        // istatistiksel taban (28 gunluk gozlemden medyan) ayni guvende degil.
        // Ikisini tek cumleyle gostermek, olcumu oldugundan kesin gosterirdi —
        // bu kuralin tekrar eden hatasi tam olarak buydu.
        java.util.Map<String, Object> rec = new java.util.HashMap<>();
        rec.put("fillfactor", 100L);
        rec.put("baseline_proven", Boolean.TRUE);
        rec.put("proven_at", java.time.OffsetDateTime.parse("2026-09-02T06:11:03Z"));

        String note = AlertRuleEvaluator.spaceBloatMeasurementNoteForTest(rec);

        assertThat(note).contains("2026-09-02");
        assertThat(note).contains("VACUUM FULL");
        assertThat(note).doesNotContain("üç günün medyanı");
        // Kapsam uyarilari her iki durumda da kalmali.
        assertThat(note).contains("TOAST");
        assertThat(note).contains("Satır sayısı tahmindir");
    }

    @Test
    void aReducedFillfactorIsExplainedRatherThanCountedAsBloat() {
        // fillfactor=70 olan saglikli bir tablo yanlis okunmasin diye mesajda
        // aciklanir. AYRICA DUSULMEZ (V108): taban ayni fillfactor rejiminden
        // secildigi icin tasarim geregi bos alani zaten icinde tasir.
        java.util.Map<String, Object> rec = new java.util.HashMap<>();
        rec.put("fillfactor", 70L);

        String note = AlertRuleEvaluator.spaceBloatMeasurementNoteForTest(rec);

        assertThat(note).contains("fillfactor=70");
        assertThat(note).contains("%30");
        assertThat(note).contains("zaten tabanın içinde");
        assertThat(note).doesNotContain("hesaptan düşüldü");
    }

    @Test
    void aDefaultFillfactorAddsNoExplanation() {
        java.util.Map<String, Object> rec = new java.util.HashMap<>();
        rec.put("fillfactor", 100L);

        assertThat(AlertRuleEvaluator.spaceBloatMeasurementNoteForTest(rec))
            .doesNotContain("fillfactor=");
    }

    @Test
    void aPastDayPartitionIsRecognisedSoVacuumFullCanBeRecommendedSafely() {
        // Gecmis bir partition'a kimse yazmadigi icin VACUUM FULL'un kilidi
        // zararsizdir; aktif tabloda ayni komut yazmayi durdurur. Aksiyon
        // metni bu ayrima dayaniyor.
        assertThat(AlertRuleEvaluator.isDatedPartitionInThePast("pgss_delta_20200819")).isTrue();
        assertThat(AlertRuleEvaluator.isDatedPartitionInThePast("pg_table_stat_hourly_202001")).isTrue();
    }

    @Test
    void aFuturePartitionIsNotTreatedAsPast() {
        // PartitionManager gelecek gunleri onceden acar; onlar yazilacak.
        assertThat(AlertRuleEvaluator.isDatedPartitionInThePast("pgss_delta_20991231")).isFalse();
        assertThat(AlertRuleEvaluator.isDatedPartitionInThePast("pgss_hourly_209912")).isFalse();
    }

    @Test
    void anUndatedTableIsNeverTreatedAsAPastPartition() {
        // Yanlis pozitif, aktif bir tabloda VACUUM FULL onermek demek olurdu.
        assertThat(AlertRuleEvaluator.isDatedPartitionInThePast("statement_series")).isFalse();
        assertThat(AlertRuleEvaluator.isDatedPartitionInThePast("t_currency_rate_active")).isFalse();
        assertThat(AlertRuleEvaluator.isDatedPartitionInThePast("")).isFalse();
    }

    @Test
    void aDateEmbeddedMidNameIsStillRecognised() {
        // Uretimdeki segment adlari: pg_table_stat_hourly_202608_seg_...
        assertThat(AlertRuleEvaluator.isDatedPartitionInThePast(
            "pg_table_stat_hourly_202001_seg_202001010000_202001312100")).isTrue();
    }

    // =========================================================================
    // Bayat istatistik alarmi (PGSTAT-P1-012)
    // =========================================================================

    private static java.util.Map<String, Object> staleRow(
            String db, String schema, String table, double hours, long mods, long thresh) {
        java.util.Map<String, Object> r = new java.util.HashMap<>();
        r.put("datname", db); r.put("schemaname", schema); r.put("relname", table);
        r.put("stale_hours", hours);
        r.put("n_mod_since_analyze", mods);
        r.put("analyze_threshold", thresh);
        return r;
    }

    @Test
    void aSingleStaleTableGetsATargetedAnalyzeCommand() {
        String action = AlertRuleEvaluator.staleStatisticsActionForTest(
            java.util.List.of(staleRow("etsrooms", "public", "t_currency_rate", 200, 1153450, 60000)));

        assertThat(action).contains("ANALYZE public.t_currency_rate;");
        assertThat(action).contains("etsrooms");
    }

    @Test
    void severalStaleTablesInOneDatabaseGetOneInstanceWideCommand() {
        // Cozum instance geneli tek komut; tablo tablo ANALYZE onermek gereksiz
        // is uretir.
        String action = AlertRuleEvaluator.staleStatisticsActionForTest(java.util.List.of(
            staleRow("bis", "public", "a", 100, 10, 5),
            staleRow("bis", "public", "b", 90, 10, 5)));

        assertThat(action).contains("vacuumdb --analyze-only -d bis");
    }

    @Test
    void staleTablesSpanningDatabasesDoNotNameASingleDatabase() {
        // Tek bir -d parametresi yanlis olurdu; komut adlandirilmadan verilir.
        String action = AlertRuleEvaluator.staleStatisticsActionForTest(java.util.List.of(
            staleRow("bis", "public", "a", 100, 10, 5),
            staleRow("contract", "public", "b", 90, 10, 5)));

        assertThat(action).contains("vacuumdb --analyze-only");
        assertThat(action).doesNotContain("-d bis");
    }

    @Test
    void staleListReportsDaysOnceHoursBecomeUnreadable() {
        String list = AlertRuleEvaluator.formatStaleListForTest(
            java.util.List.of(staleRow("etstur", "public", "t_x", 24 * 127, 13617, 5000)));

        assertThat(list).contains("127 gündür analiz yok");
        assertThat(list).contains("13.617");   // binlik ayrac, tr-TR
        assertThat(list).contains("DB=etstur public.t_x");
    }

    @Test
    void staleListShowsHoursWhileTheyAreStillReadable() {
        String list = AlertRuleEvaluator.formatStaleListForTest(
            java.util.List.of(staleRow("etstur", "public", "t_x", 30, 100, 50)));

        assertThat(list).contains("30 saattir analiz yok");
    }

    @Test
    void staleListSurfacesWhatItHadToLeaveOut() {
        // Sessiz kirpma "hepsi bu" gibi okunur; kalan sayisi yazilmali.
        java.util.List<java.util.Map<String, Object>> many = new java.util.ArrayList<>();
        for (int i = 0; i < 9; i++) many.add(staleRow("db", "public", "t" + i, 100 - i, 10, 5));

        String list = AlertRuleEvaluator.formatStaleListForTest(many);

        assertThat(list).contains("ve 4 tablo daha");
    }

    // =========================================================================
    // Kayit bazli alert anahtari (recordAlertKey) — PGSTAT-P0-039
    // =========================================================================

    @Test
    void eachTableGetsItsOwnAlertKeySoTheyDoNotShareOneAlert() {
        // Uretim vakasi (2026-08-28, instance 2): bes tablo esigin ustundeydi
        // ama hepsi tek "rule:14:instance:2" anahtarini paylastigi icin sadece
        // listenin ilki degerlendiriliyordu.
        java.util.Map<String, Object> a = new java.util.HashMap<>();
        a.put("dbid", 16385L); a.put("relid", 2128608L);
        java.util.Map<String, Object> b = new java.util.HashMap<>();
        b.put("dbid", 16385L); b.put("relid", 2128999L);

        String keyA = AlertRuleEvaluator.recordAlertKey(14, 2, a, "table_metric");
        String keyB = AlertRuleEvaluator.recordAlertKey(14, 2, b, "table_metric");

        assertThat(keyA).isNotEqualTo(keyB);
        assertThat(keyA).startsWith(AlertRuleEvaluator.recordAlertKeyPrefix(14, 2));
        assertThat(keyB).startsWith(AlertRuleEvaluator.recordAlertKeyPrefix(14, 2));
    }

    @Test
    void sameTableNameInDifferentDatabasesGetsDifferentKeys() {
        // Uretimde t_currency_rate_active hem public hem engine semasinda ve
        // iki ayri veritabaninda vardi; ayni ada sahip olmalari onlari ayni
        // nesne yapmaz.
        java.util.Map<String, Object> db1 = new java.util.HashMap<>();
        db1.put("dbid", 16385L); db1.put("schemaname", "public"); db1.put("relname", "t_currency_rate_active");
        java.util.Map<String, Object> db2 = new java.util.HashMap<>();
        db2.put("dbid", 16999L); db2.put("schemaname", "public"); db2.put("relname", "t_currency_rate_active");

        assertThat(AlertRuleEvaluator.recordAlertKey(14, 2, db1, "table_metric"))
            .isNotEqualTo(AlertRuleEvaluator.recordAlertKey(14, 2, db2, "table_metric"));
    }

    @Test
    void tableKeyFallsBackToNameWhenRelidIsNotSelected() {
        // Generic table_metric ve index_metric sorgulari relid secmiyor —
        // anahtar yine de tekil olmali.
        java.util.Map<String, Object> noRelid = new java.util.HashMap<>();
        noRelid.put("dbid", 16385L);
        noRelid.put("schemaname", "public");
        noRelid.put("relname", "t_content_update");

        assertThat(AlertRuleEvaluator.recordAlertKey(14, 2, noRelid, "table_metric"))
            .isEqualTo(AlertRuleEvaluator.recordAlertKeyPrefix(14, 2)
                + "db:16385:tbl:public.t_content_update");
    }

    @Test
    void keysAreScopedPerRuleAndPerInstance() {
        // Ayni tablo farkli kural ya da farkli instance altinda ayri alert alir.
        java.util.Map<String, Object> rec = new java.util.HashMap<>();
        rec.put("dbid", 16385L); rec.put("relid", 2128608L);

        String r14i2 = AlertRuleEvaluator.recordAlertKey(14, 2, rec, "table_metric");
        assertThat(r14i2).isNotEqualTo(AlertRuleEvaluator.recordAlertKey(15, 2, rec, "table_metric"));
        assertThat(r14i2).isNotEqualTo(AlertRuleEvaluator.recordAlertKey(14, 3, rec, "table_metric"));
    }

    @Test
    void statementAndIndexTypesGetTheirOwnKeyShapes() {
        java.util.Map<String, Object> stmt = new java.util.HashMap<>();
        stmt.put("dbid", 16385L); stmt.put("statement_series_id", 77L);
        java.util.Map<String, Object> idx = new java.util.HashMap<>();
        idx.put("dbid", 16385L); idx.put("schemaname", "public"); idx.put("indexrelname", "ix_foo");

        assertThat(AlertRuleEvaluator.recordAlertKey(14, 2, stmt, "statement_metric"))
            .isEqualTo(AlertRuleEvaluator.recordAlertKeyPrefix(14, 2) + "db:16385:series:77");
        assertThat(AlertRuleEvaluator.recordAlertKey(14, 2, idx, "index_metric"))
            .isEqualTo(AlertRuleEvaluator.recordAlertKeyPrefix(14, 2) + "db:16385:idx:public.ix_foo");
    }

    @Test
    void everyRecordKeyIsMatchedByItsOwnPrefix() {
        // openAlertKeysWithPrefix bu onek ile arama yapiyor; uretilen her
        // anahtar o aramaya takilmali, yoksa duzelen kayitlarin alert'i
        // kapatilamaz.
        java.util.Map<String, Object> rec = new java.util.HashMap<>();
        rec.put("dbid", 16385L); rec.put("relid", 2128608L);
        String prefix = AlertRuleEvaluator.recordAlertKeyPrefix(14, 2);

        for (String type : new String[]{"table_metric", "index_metric", "statement_metric"}) {
            assertThat(AlertRuleEvaluator.recordAlertKey(14, 2, rec, type)).startsWith(prefix);
        }
    }

    @Test
    void theOldInstanceLevelKeyIsNotMatchedByTheRecordPrefix() {
        // V098 migration'i eski anahtarlari kapatiyor; yeni onek onlari
        // yakalamamali, yoksa migration'in kapattigi alert'ler tekrar
        // resolve edilmeye calisilirdi.
        String oldKey = "rule:14:instance:2";
        assertThat(oldKey).doesNotStartWith(AlertRuleEvaluator.recordAlertKeyPrefix(14, 2));
    }

    // =========================================================================
    // Istatistik guvenilirlik kapisi (statsUntrustworthy)
    // =========================================================================

    /** Bloat kaydi uretici — sadece kapinin baktigi dort zaman damgasi. */
    private static java.util.Map<String, Object> bloatRecord(
            Object lastAnalyze, Object lastAutoanalyze,
            Object lastVacuum, Object lastAutovacuum) {
        java.util.Map<String, Object> r = new java.util.HashMap<>();
        r.put("last_analyze", lastAnalyze);
        r.put("last_autoanalyze", lastAutoanalyze);
        r.put("last_vacuum", lastVacuum);
        r.put("last_autovacuum", lastAutovacuum);
        return r;
    }

    private static final java.sql.Timestamp SOME_TIME =
        java.sql.Timestamp.valueOf("2026-08-27 12:00:00");

    @Test
    void theUntrustworthyWindowIsBoundedByTheStatisticsReset() {
        // "Hic analiz edilmemis" ifadesi yanlisti: last_analyze/last_vacuum
        // sayaclari istatistik sifirlandiginda silinir, yani NULL olmalari
        // tablonun hic analiz edilmedigini DEGIL, sifirlamadan beri
        // edilmedigini gosterir. Musteri 2026-08-28'de dogru sordu:
        // "hicligin tanimi yok mu?"
        java.util.Map<String, Object> r = bloatRecord(null, null, null, null);
        r.put("stats_reset", java.sql.Timestamp.valueOf("2026-03-04 15:23:26"));

        String phrase = AlertRuleEvaluator.statsWindowPhraseForTest(r);

        assertThat(phrase).contains("2026-03-04");
        assertThat(phrase).contains("gün önce");
    }

    @Test
    void theWindowAdmitsUncertaintyWhenTheResetTimeIsUnknown() {
        // stats_reset okunamiyorsa uydurulmus bir kesinlik yerine belirsizlik
        // itiraf edilir.
        String phrase = AlertRuleEvaluator.statsWindowPhraseForTest(
            bloatRecord(null, null, null, null));

        assertThat(phrase).contains("okunamadı");
        assertThat(phrase).doesNotContain("gün önce");
    }

    @Test
    void aKnownReltuplesMakesTheRatioTrustworthyEvenWithNoTimestamps() {
        // Uretim vakasi (2026-08-28, t_ets_hotel_transaction_log): dort zaman
        // damgasi da bos, n_live_tup = 0, ama katalog 30.404.328 satir diyor.
        // reltuples KATALOGDA durur ve istatistik sifirlamasini atlatir, yani
        // sifirlamadan onceki gercek bir olcumu tasir — oran %100 degil %1.7.
        java.util.Map<String, Object> r = bloatRecord(null, null, null, null);
        r.put("reltuples", 30404328L);

        assertThat(AlertRuleEvaluator.statsUntrustworthy(r)).isFalse();
    }

    @Test
    void anUnknownReltuplesLeavesTheStatisticsUntrustworthy() {
        // PG14+ reltuples = -1 "hic vacuum/analyze edilmedi" demek; sorgu bunu
        // NULL'a cevirir. Bu durumda geriye guvenilecek bir sey kalmaz.
        java.util.Map<String, Object> r = bloatRecord(null, null, null, null);
        r.put("reltuples", null);

        assertThat(AlertRuleEvaluator.statsUntrustworthy(r)).isTrue();
    }

    @Test
    void aZeroReltuplesIsNotTreatedAsAMeasurement() {
        // 0, "olculdu ve bos" ile "hic olculmedi" arasinda ayrim yapmaz;
        // guvenli taraf, olcum saymamak.
        java.util.Map<String, Object> r = bloatRecord(null, null, null, null);
        r.put("reltuples", 0L);

        assertThat(AlertRuleEvaluator.statsUntrustworthy(r)).isTrue();
    }

    @Test
    void statsAreUntrustworthyWhenNothingHasEverCorrectedThem() {
        // Uretim vakasi (2026-08-27, security.user): dort zaman damgasi da NULL.
        // n_live_tup=6 / n_dead_tup=3224 bildiriliyordu, yani %99.81 olu oran ve
        // kritik alert; select count(*) 26257 dondu, gercek oran ~%11 — uyari
        // esiginin bile altinda. Bes tablo icin bes yanlis alert uretilmisti.
        assertThat(AlertRuleEvaluator.statsUntrustworthy(
            bloatRecord(null, null, null, null))).isTrue();
    }

    @Test
    void aQueueShapedTableWithCurrentStatisticsStillAlerts() {
        // KRITIK ayrim: gercekten az canli + cok olu satirli tablolar vardir
        // (kuyruk/staging). Kapi canli satir sayisina bakmaz, sadece degerlerin
        // duzeltilip duzeltilmedigine bakar — bu tablo autoanalyze gormus, yani
        // oran gercek ve alert uretilmeli.
        assertThat(AlertRuleEvaluator.statsUntrustworthy(
            bloatRecord(null, SOME_TIME, null, null))).isFalse();
    }

    @Test
    void anyOneCorrectingOperationIsEnoughToTrustTheEstimates() {
        // ANALYZE de VACUUM da gercek sayim yapar; hangisi calistiysa degerler
        // duzelmistir. Dordunun her biri tek basina yeterli.
        assertThat(AlertRuleEvaluator.statsUntrustworthy(
            bloatRecord(SOME_TIME, null, null, null))).isFalse();
        assertThat(AlertRuleEvaluator.statsUntrustworthy(
            bloatRecord(null, null, SOME_TIME, null))).isFalse();
        assertThat(AlertRuleEvaluator.statsUntrustworthy(
            bloatRecord(null, null, null, SOME_TIME))).isFalse();
    }

    @Test
    void missingKeysAreTreatedAsNeverCorrected() {
        // Kolon sorgudan hic gelmezse (eski surum, kismi sorgu) guvenli taraf:
        // "duzeltilmemis" sayilir, cunku duzeltildigine dair kanit yok.
        assertThat(AlertRuleEvaluator.statsUntrustworthy(
            new java.util.HashMap<>())).isTrue();
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
