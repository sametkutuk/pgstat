package com.pgstat.collector.collector;

import org.junit.jupiter.api.Test;

import java.math.BigDecimal;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Fiziksel nesil degisiminin siniflandirilmasi (PGSTAT-P0-046 Faz 2).
 *
 * Bu testlerin varlik sebebi tek bir karsi ornek: dis inceleme (2026-09-01)
 * "relfilenode degisti = tablo sikisti" varsayiminin YANLIS oldugunu gosterdi.
 * ALTER TABLE ... SET TABLESPACE de filenode degistirir ama fork'lari blok blok
 * kopyalar; sisme aynen korunur. O olayi sikistirma sayarsak, sismis bir
 * tablonun sismis halini "sikisik taban" olarak kaydeder ve sismeyi bir daha
 * hic goremeyiz.
 */
class PhysicalGenerationTest {

    /** Satir sayisi supheli olmayan tablolar icin kisayol. */
    private static String classify(Long prevTs, Long newTs, Long reltuples,
                                   Long relpages, Integer blockSize) {
        return DbObjectsCollector.classifyGenerationChange(
            prevTs, newTs, reltuples, relpages, blockSize, null);
    }

    @Test
    void aTablespaceMoveIsNotCompaction() {
        // SET TABLESPACE: filenode degisir, satirlar durur, sisme KORUNUR.
        assertThat(classify(1663L, 99999L, 1_000_000L, 50_000L, 8192))
            .isEqualTo("storage_move");
    }

    @Test
    void aTablespaceMoveWinsOverEverythingElse() {
        // Tablespace kontrolu ONCE yapilmali. Aksi halde tasima islemi,
        // "satir var + sayfa var" oldugu icin sikistirma sayilirdi.
        assertThat(classify(0L, 1663L, 500_000L, 10_000L, 8192))
            .isEqualTo("storage_move");
    }

    @Test
    void aRewriteInTheSameTablespaceIsACompactionCandidate() {
        // VACUUM FULL / CLUSTER: ayni tablespace, filenode degisti, satir var.
        assertThat(classify(0L, 0L, 1_000_000L, 20_000L, 8192))
            .isEqualTo("compacting_rewrite_candidate");
    }

    @Test
    void nullAndZeroTablespaceMeanTheSameThing() {
        // pg_class.reltablespace = 0 "veritabaninin varsayilani" demektir.
        // NULL ile 0'i farkli saymak, her tabloyu tasima gibi gosterirdi.
        assertThat(classify(null, 0L, 1_000_000L, 20_000L, 8192))
            .isEqualTo("compacting_rewrite_candidate");
        assertThat(classify(0L, null, 1_000_000L, 20_000L, 8192))
            .isEqualTo("compacting_rewrite_candidate");
    }

    @Test
    void anEmptyTableIsATruncateNotABaseline() {
        // TRUNCATE sonrasi tablo bostur; satir basina alan hesaplanamaz ve
        // taban olarak kullanilamaz. Istatistikler de sifir goruyor.
        assertThat(DbObjectsCollector.classifyGenerationChange(
                0L, 0L, 0L, 0L, 8192, 0L))
            .isEqualTo("truncate");
    }

    @Test
    void anUnknownRowCountIsNotAnEmptyTable() {
        // PG14+ pg_class.reltuples = -1 "BILINMIYOR" demektir, "bos" degil.
        // Kaynak sorguda nullif ile NULL'a cevriliyor. Bunu truncate saymak,
        // hic analiz gormemis tablolari bos ilan etmek olurdu — canli veride
        // tam bu oldu (2026-09-02): -1 tasiyan onlarca tablo truncate
        // isaretlendi ve sayilari hicbir zaman bos degildi.
        assertThat(classify(0L, 0L, null, 5L, 8192))
            .isEqualTo("unknown");
    }

    @Test
    void onPg12And13AZeroRowCountWithLiveRowsIsUnknownNotEmpty() {
        // PG12/13'te "-1 = bilinmiyor" sentineli YOK; sifir hem gercekten bos
        // hem hic analiz gormemis demek ve katalog tek basina ayiramaz.
        // Desteklenen taban PG12 (docs/platform-governance-and-sdlc.md 2), yani
        // bu ayrim yapilmak zorunda.
        //
        // n_live_tup pozitifse tablo bos DEGILDIR; taban olarak kullanilamaz
        // ama "bos" da denemez.
        assertThat(DbObjectsCollector.classifyGenerationChange(
                0L, 0L, 0L, 0L, 8192, 4_200L))
            .isEqualTo("unknown");
    }

    @Test
    void theSameRuleHoldsOnPg14WhereTheTwoSourcesContradictEachOther() {
        // Surum dallanmasi yok, cunku ayni cevap PG14+'ta da dogru: reltuples
        // sifir derken n_live_tup satir goruyorsa iki kaynak CELISIYOR ve
        // celiskiye dayali bir taban zaten kullanilmamali.
        assertThat(DbObjectsCollector.classifyGenerationChange(
                0L, 0L, 0L, 12L, 8192, 900L))
            .isEqualTo("unknown");
    }

    @Test
    void unknownLiveTupleCountDoesNotTurnAnEmptyTableIntoAnUnknownOne() {
        // n_live_tup okunamadiysa elimizde tek kaynak var: reltuples = 0.
        // Ona uyulur; yokluktan supheli durum uretilmez.
        assertThat(DbObjectsCollector.classifyGenerationChange(
                0L, 0L, 0L, 0L, 8192, null))
            .isEqualTo("truncate");
    }

    @Test
    void missingPageOrBlockSizeYieldsUnknownRatherThanAGuess() {
        // Taban hesaplanamiyorsa "bilmiyorum" denir. Uydurulmus bir taban,
        // sessizlikten zararlidir — bu kuralin tekrar eden dersi.
        assertThat(classify(0L, 0L, 1_000L, null, 8192)).isEqualTo("unknown");
        assertThat(classify(0L, 0L, 1_000L, 10L, null)).isEqualTo("unknown");
    }

    @Test
    void compactDensityComesFromRelpagesNotFromTheMeasuredSize() {
        // 20.000 sayfa * 8192 bayt / 1.000.000 satir = 163.84 bayt/satir.
        //
        // relpages ve reltuples'i rewrite BIRLIKTE yazar; tutarli bir cifttir.
        // pg_relation_size kullanilsaydi, tespit ile rewrite arasinda gecen
        // surede buyumus bir boyut event-time satir sayisina bolunurdu ve
        // yogunluk oldugundan yuksek cikardi.
        assertThat(DbObjectsCollector.compactBytesPerRow(20_000L, 8192, 1_000_000L))
            .isEqualByComparingTo(new BigDecimal("163.840000"));
    }

    @Test
    void densityIsNullWhenItCannotBeComputed() {
        assertThat(DbObjectsCollector.compactBytesPerRow(null, 8192, 1_000L)).isNull();
        assertThat(DbObjectsCollector.compactBytesPerRow(10L, null, 1_000L)).isNull();
        assertThat(DbObjectsCollector.compactBytesPerRow(10L, 8192, 0L)).isNull();
        assertThat(DbObjectsCollector.compactBytesPerRow(10L, 8192, null)).isNull();
    }
}
