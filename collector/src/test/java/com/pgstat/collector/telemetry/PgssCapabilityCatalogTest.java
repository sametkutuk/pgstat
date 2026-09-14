package com.pgstat.collector.telemetry;

import com.pgstat.collector.telemetry.PgssCapabilityCatalog.PgssVersion;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * pgss yetenek katalogu (PGSTAT-P1-021 / M1).
 *
 * Katalogdaki surum sinirlari gercek PostgreSQL'de olculdu; bu testler o
 * olcumun kodda dogru karsiligi uretildigini dogruluyor. Uretilen SQL ayrica
 * target/pgss-sql/ altina yazilir ve gercek bir PostgreSQL'e karsi
 * kosturulabilir — CI'da bu adimi otomatiklestirmek PGSTAT-P1-020'ye bagli.
 */
class PgssCapabilityCatalogTest {

    private final PgssCapabilityCatalog catalog = new PgssCapabilityCatalog();

    // -----------------------------------------------------------------------
    // Surum karsilastirmasi
    // -----------------------------------------------------------------------

    @Test
    void versionComparisonIsNumericNotLexical() {
        // "1.4" > "1.10" metin olarak DOGRU, surum olarak YANLIS. Bu hata
        // sessizce yanlis projection secer ve tam da onlemeye calistigimiz
        // kirilmayi uretir.
        assertThat(PgssVersion.of("1.4")).isLessThan(PgssVersion.of("1.10"));
        assertThat(PgssVersion.of("1.9")).isLessThan(PgssVersion.of("1.10"));
        assertThat(PgssVersion.of("1.11")).isGreaterThan(PgssVersion.of("1.9"));
    }

    @Test
    void anUnparseableVersionIsNullNotZero() {
        // Bozuk bir surum metnini 0.0 saymak, onu en dusuk surum gibi
        // gosterip guvenli tabana duserdi — ama sessizce. null, cagiranin
        // "bilmiyorum" durumunu acikca ele almasini zorunlu kilar.
        assertThat(PgssVersion.of("bozuk")).isNull();
        assertThat(PgssVersion.of("")).isNull();
        assertThat(PgssVersion.of(null)).isNull();
    }

    // -----------------------------------------------------------------------
    // Olculen sinirlar
    // -----------------------------------------------------------------------

    @Test
    void jitColumnsArrivedTogetherAtOneTen() {
        // OLCULDU: tum jit_* kolonlari 1.10'da BIRLIKTE geldi. Repo'nun
        // Pg14_16 sorgusu bir kismini daha erken varmis gibi dogrudan referans
        // ediyordu ve pgss 1.9'da (PG14'un varsayilani) sorgu komple patliyordu.
        assertThat(catalog.buildSelectList(PgssVersion.of("1.9")))
            .doesNotContain("jit_generation_time as")   // kaynak referansi yok
            .contains("0::double precision as jit_generation_time");

        assertThat(catalog.buildSelectList(PgssVersion.of("1.10")))
            .contains("jit_generation_time as jit_generation_time");
    }

    @Test
    void toplevelAppearsAtOneNine() {
        assertThat(catalog.buildSelectList(PgssVersion.of("1.8")))
            .contains("null::boolean as toplevel");
        assertThat(catalog.buildSelectList(PgssVersion.of("1.9")))
            .contains("toplevel as toplevel");
    }

    @Test
    void theExecutionTimeRenameAtOneEightIsHandledBothWays() {
        // 1.8 oncesi total_time, sonrasi total_exec_time. Ayni olcum.
        assertThat(catalog.buildSelectList(PgssVersion.of("1.7")))
            .contains("total_time as total_exec_time");
        assertThat(catalog.buildSelectList(PgssVersion.of("1.8")))
            .contains("total_exec_time as total_exec_time");
    }

    @Test
    void theRemovedBlockTimeColumnsAreRebuiltAtOneEleven() {
        // KATALOGDAKI TEK KALDIRMA: 1.11'de blk_read_time/blk_write_time
        // kaldirildi. Merkezi sema o kolonu tutmaya devam ettigi icin
        // 1.11+'da shared+local+temp toplanarak ayni anlam korunuyor.
        assertThat(catalog.buildSelectList(PgssVersion.of("1.10")))
            .contains("blk_read_time as blk_read_time");

        String v11 = catalog.buildSelectList(PgssVersion.of("1.11"));
        assertThat(v11).contains("shared_blk_read_time,0")
                       .contains("local_blk_read_time,0")
                       .contains("as blk_read_time");
    }

    // -----------------------------------------------------------------------
    // Bilinmeyen ve dogrulanmamis sinirlar
    // -----------------------------------------------------------------------

    @Test
    void anUnknownVersionReadsEveryVersionedColumnDefensively() {
        // "En dusuk surumun projection'i her yerde calisir" varsayimi YANLIS
        // ve bu gercek PostgreSQL'de olculdu: 1.8 total_time'i total_exec_time
        // olarak yeniden adlandirdi, yani 1.4 projection'i 1.8+ uzerinde
        // patliyor. Bilinmeyen surumde surume bagli her kolon to_jsonb ile
        // okunur; boylece sorgu hicbir surumde dusmez.
        String unknown = catalog.buildSelectList(null);
        assertThat(unknown)
            .contains("(j->>'total_exec_time')")
            .contains("(j->>'total_time')")
            .contains("(j->>'toplevel')");
        assertThat(unknown).isNotEqualTo(catalog.buildSelectList(PgssCapabilityCatalog.FLOOR));
    }

    @Test
    void unverifiedBoundariesAreAlwaysReadSafely() {
        // 1.12 (PG18) sinirlari OLCULMEDI. Dogrudan referans, sinir yanlissa
        // sorgunun TAMAMINI dusurur; to_jsonb ile okumak yalnizca o kolonu
        // bosaltir. Emin olmadigimiz yerde tahmin degil, guvenli yol.
        String v12 = catalog.buildSelectList(PgssVersion.of("1.12"));
        assertThat(v12).contains("(j->>'parallel_workers_launched')")
                       .contains("(j->>'wal_buffers_full')");
    }

    @Test
    void everyVersionProducesTheSameTargetColumns() {
        // Merkezi sema tek tip. Hangi surum olursa olsun ayni hedef kolonlar
        // ayni sirada uretilmeli; aksi halde insert parametre sirasi kayar.
        int expected = catalog.targetColumns().size();
        for (String v : new String[]{"1.4", "1.7", "1.8", "1.9", "1.10", "1.11", "1.12"}) {
            String sql = catalog.buildSelectList(PgssVersion.of(v));
            assertThat(sql.split(",\n")).as("surum " + v).hasSize(expected);
        }
        assertThat(catalog.buildSelectList(null).split(",\n")).hasSize(expected);
    }

    @Test
    void capabilityAvailabilityTracksTheVersion() {
        assertThat(catalog.availableCapabilities(PgssVersion.of("1.7")))
            .contains("statements.execution", "statements.blocks")
            .doesNotContain("statements.planning", "statements.jit");

        assertThat(catalog.missingCapabilities(PgssVersion.of("1.9")))
            .contains("statements.jit", "statements.stats_window")
            .doesNotContain("statements.toplevel");
    }

    // -----------------------------------------------------------------------
    // Gercek PostgreSQL dogrulamasi icin cikti
    // -----------------------------------------------------------------------

    @Test
    void generatedSqlIsWrittenForRealDatabaseVerification() throws Exception {
        // Birim testi SQL'in GECERLI oldugunu kanitlayamaz, yalnizca beklenen
        // metni urettigini. Gercek dogrulama bu dosyalarin bir PostgreSQL'e
        // karsi kosturulmasiyla yapilir.
        Path dir = Path.of("target", "pgss-sql");
        Files.createDirectories(dir);
        for (String v : new String[]{"1.4", "1.7", "1.8", "1.9", "1.10", "1.11", "1.12"}) {
            Files.writeString(dir.resolve("pgss-" + v + ".sql"),
                catalog.buildStatsQuery("pg_stat_statements", PgssVersion.of(v)) + ";\n");
        }
        Files.writeString(dir.resolve("pgss-unknown.sql"),
            catalog.buildStatsQuery("pg_stat_statements", null) + ";\n");

        assertThat(dir.resolve("pgss-1.11.sql")).exists();
    }
}
