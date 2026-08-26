package com.pgstat.collector.service;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * DeltaCalculator'in null-aware sozlesmesi (PGSTAT-P1-011 kod onkosulu 9/10).
 *
 * Kritik kural: kaynak sayac NULL geldiginde sonuc da NULL olmali, 0 DEGIL.
 * "Olculemedi" ile "sifir olculdu" farkli seylerdir ve bu ayrim
 * fact.pg_io_stat_delta'ya kadar korunmalidir — Teshis 0'in
 * NO_FRESH_DATA vs. ZERO_IO_WITH_FRESH_DATA ayrimi buna dayanir.
 */
class DeltaCalculatorTest {

    private final DeltaCalculator calc = new DeltaCalculator();

    @Test
    void nullCurrentYieldsNullNotZero() {
        assertThat(calc.deltaLong(null, 100L)).isNull();
        assertThat(calc.deltaDouble(null, 100.0)).isNull();
    }

    @Test
    void nullPreviousYieldsNullBecauseThereIsNoBaseline() {
        assertThat(calc.deltaLong(100L, null)).isNull();
        assertThat(calc.deltaDouble(100.0, null)).isNull();
    }

    @Test
    void zeroDeltaIsAValidMeasurementAndIsPreserved() {
        // Sifir delta gecerli bir olcumdur — null ile karistirilmamali.
        assertThat(calc.deltaLong(100L, 100L)).isEqualTo(0L);
        assertThat(calc.deltaDouble(100.0, 100.0)).isEqualTo(0.0);
    }

    @Test
    void normalIncreaseProducesTheDifference() {
        assertThat(calc.deltaLong(150L, 100L)).isEqualTo(50L);
        assertThat(calc.deltaDouble(150.5, 100.0)).isEqualTo(50.5);
    }

    @Test
    void negativeDeltaIsRejectedBecauseItMeansCounterReset() {
        // Sayac geriye gitmisse (reset/wraparound) delta anlamsizdir.
        assertThat(calc.deltaLong(50L, 100L)).isNull();
        assertThat(calc.deltaDouble(50.0, 100.0)).isNull();
    }

    @Test
    void tinyNegativeDoubleIsTreatedAsZeroNotAsReset() {
        // Floating point hatasi kaynakli -0.0005 gibi degerler reset degil.
        assertThat(calc.deltaDouble(99.9995, 100.0)).isEqualTo(0.0);
    }

    @Test
    void hasAnyChangeIgnoresNullsAndZeros() {
        assertThat(calc.hasAnyChange(null, 0L, null)).isFalse();
        assertThat(calc.hasAnyChange(null, 0L, 5L)).isTrue();
    }
}
