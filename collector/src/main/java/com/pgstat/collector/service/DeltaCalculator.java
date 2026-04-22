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
     * Iki kumulatif long deger arasindaki delta'yi hesaplar.
     *
     * @param current  su anki kumulatif deger
     * @param previous onceki kumulatif deger (null ise baseline)
     * @return delta degeri; negatifse veya previous null ise null
     */
    public Long deltaLong(long current, Long previous) {
        if (previous == null) return null;

        long diff = current - previous;
        // Negatif delta → stats reset veya wraparound; bu sample'i atla
        return diff >= 0 ? diff : null;
    }

    /**
     * Iki kumulatif double deger arasindaki delta'yi hesaplar.
     *
     * @param current  su anki kumulatif deger
     * @param previous onceki kumulatif deger (null ise baseline)
     * @return delta degeri; negatifse veya previous null ise null
     */
    public Double deltaDouble(double current, Double previous) {
        if (previous == null) return null;

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
