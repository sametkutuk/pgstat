package com.pgstat.collector.service;

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

        assertThat(AlertRuleEvaluator.parseRelOption(raw, "autovacuum_vacuum_cost_delay"))
            .isEqualTo(10);
    }

    @Test
    void returnsNullWhenOptionAbsentOrUnparsable() {
        assertThat(AlertRuleEvaluator.parseRelOption("{fillfactor=90}", "autovacuum_vacuum_cost_delay"))
            .isNull();
        assertThat(AlertRuleEvaluator.parseRelOption("{autovacuum_vacuum_cost_delay=abc}", "autovacuum_vacuum_cost_delay"))
            .isNull();
        assertThat(AlertRuleEvaluator.parseRelOption(null, "autovacuum_vacuum_cost_delay")).isNull();
        assertThat(AlertRuleEvaluator.parseRelOption("", "autovacuum_vacuum_cost_delay")).isNull();
    }

    @Test
    void preservesMinusOneSentinelRatherThanTreatingItAsAValue() {
        // -1 "global ayari kullan" demek; cozumleme zinciri bunu bir deger
        // olarak degil, bir sonraki adima gecis sinyali olarak gormeli.
        assertThat(AlertRuleEvaluator.parseRelOption(
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
}
