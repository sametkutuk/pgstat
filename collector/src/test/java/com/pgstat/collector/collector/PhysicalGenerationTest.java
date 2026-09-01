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

    @Test
    void aTablespaceMoveIsNotCompaction() {
        // SET TABLESPACE: filenode degisir, satirlar durur, sisme KORUNUR.
        assertThat(DbObjectsCollector.classifyGenerationChange(
                1663L, 99999L, 1_000_000L, 50_000L, 8192))
            .isEqualTo("storage_move");
    }

    @Test
    void aTablespaceMoveWinsOverEverythingElse() {
        // Tablespace kontrolu ONCE yapilmali. Aksi halde tasima islemi,
        // "satir var + sayfa var" oldugu icin sikistirma sayilirdi.
        assertThat(DbObjectsCollector.classifyGenerationChange(
                0L, 1663L, 500_000L, 10_000L, 8192))
            .isEqualTo("storage_move");
    }

    @Test
    void aRewriteInTheSameTablespaceIsACompactionCandidate() {
        // VACUUM FULL / CLUSTER: ayni tablespace, filenode degisti, satir var.
        assertThat(DbObjectsCollector.classifyGenerationChange(
                0L, 0L, 1_000_000L, 20_000L, 8192))
            .isEqualTo("compacting_rewrite_candidate");
    }

    @Test
    void nullAndZeroTablespaceMeanTheSameThing() {
        // pg_class.reltablespace = 0 "veritabaninin varsayilani" demektir.
        // NULL ile 0'i farkli saymak, her tabloyu tasima gibi gosterirdi.
        assertThat(DbObjectsCollector.classifyGenerationChange(
                null, 0L, 1_000_000L, 20_000L, 8192))
            .isEqualTo("compacting_rewrite_candidate");
        assertThat(DbObjectsCollector.classifyGenerationChange(
                0L, null, 1_000_000L, 20_000L, 8192))
            .isEqualTo("compacting_rewrite_candidate");
    }

    @Test
    void anEmptyTableIsATruncateNotABaseline() {
        // TRUNCATE sonrasi tablo bostur; satir basina alan hesaplanamaz ve
        // taban olarak kullanilamaz.
        assertThat(DbObjectsCollector.classifyGenerationChange(
                0L, 0L, 0L, 0L, 8192))
            .isEqualTo("truncate");
        assertThat(DbObjectsCollector.classifyGenerationChange(
                0L, 0L, null, 5L, 8192))
            .isEqualTo("truncate");
    }

    @Test
    void missingPageOrBlockSizeYieldsUnknownRatherThanAGuess() {
        // Taban hesaplanamiyorsa "bilmiyorum" denir. Uydurulmus bir taban,
        // sessizlikten zararlidir — bu kuralin tekrar eden dersi.
        assertThat(DbObjectsCollector.classifyGenerationChange(
                0L, 0L, 1_000L, null, 8192)).isEqualTo("unknown");
        assertThat(DbObjectsCollector.classifyGenerationChange(
                0L, 0L, 1_000L, 10L, null)).isEqualTo("unknown");
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
