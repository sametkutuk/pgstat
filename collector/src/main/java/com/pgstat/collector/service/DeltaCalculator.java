package com.pgstat.collector.service;

import org.springframework.stereotype.Service;

/**
 * Kumulatif PG sayac degerleri arasinda delta hesaplar.
 *
 * Kurallar:
 * - delta = current - previous
 * - Sonuc negatifse (stats reset veya wraparound) null doner → delta yazilmaz
 * - Onceki deger yoksa (ilk sample = baseline) null doner → delta yazilmaz
 * - Sifir delta gecerlidir ve yazilir
 */
@Service
public class DeltaCalculator {

    /**
     * Iki kumulatif long deger arasindaki delta'yi hesaplar. NULL-AWARE:
     * her iki taraf da null olabilir.
     *
     * Kaynak sayac NULL geldiginde (metrik o satirda olculememis) sonuc da
     * NULL olmalidir — 0 yazmak "olculemedi" bilgisini "sifir olculdu"ya
     * cevirir ve bu ayrimi geri getirmek imkansiz hale gelir
     * (PGSTAT-P1-011: Teshis 0'in NO_FRESH_DATA vs.
     * ZERO_IO_WITH_FRESH_DATA ayrimi buna dayanir).
     *
     * @param current  su anki kumulatif deger (null = olculemedi)
     * @param previous onceki kumulatif deger (null = baseline/olculemedi)
     * @return delta; taraflardan biri null ise veya delta negatifse null
     */
    public Long deltaLong(Long current, Long previous) {
        if (current == null || previous == null) return null;

        long diff = current - previous;
        // Negatif delta → stats reset veya wraparound; bu sample'i atla
        return diff >= 0 ? diff : null;
    }

    /**
     * Iki kumulatif double deger arasindaki delta'yi hesaplar. NULL-AWARE —
     * ayni gerekce, bkz. {@link #deltaLong(Long, Long)}.
     *
     * @param current  su anki kumulatif deger (null = olculemedi)
     * @param previous onceki kumulatif deger (null = baseline/olculemedi)
     * @return delta degeri; taraflardan biri null ise veya negatifse null
     */
    public Double deltaDouble(Double current, Double previous) {
        if (current == null || previous == null) return null;

        double diff = current - previous;
        // Negatif delta → stats reset; kucuk negatif degerler floating point
        // hatasindan kaynaklanabilir, -0.001 gibi degerleri sifira yuvarla
        if (diff < -0.001) return null;
        return Math.max(0.0, diff);
    }

    /**
     * Tum delta degerlerin en az birinin non-null ve pozitif olup olmadigini kontrol eder.
     * Eger hicbir delta degismediyse satir yazmaya gerek yoktur.
     */
    public boolean hasAnyChange(Long... deltas) {
        for (Long d : deltas) {
            if (d != null && d > 0) return true;
        }
        return false;
    }
}
