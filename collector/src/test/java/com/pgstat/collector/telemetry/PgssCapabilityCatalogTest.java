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
        assertThat(v11).contains("coalesce(shared_blk_read_time, 0) + coalesce(local_blk_read_time, 0)")
                       .contains("as blk_read_time");
    }

    @Test
    void theRebuiltBlockTimeExcludesTempAndDoesNotDoubleCount() {
        // ESKI blk_read_time = shared + local, TEMP DAHIL DEGIL. 1.11 oncesinde
        // pgss gecici dosya G/C suresini blk_read_time icinde HIC olcmuyordu;
        // temp_blk_read_time ayri bir kolon olarak 1.10'da geldi.
        //
        // Uceyi toplamak hem eski anlami degistirir hem temp'i IKI KEZ sayar
        // (bir kez blk_read_time icinde, bir kez kendi kolonunda). Bu hata
        // mevcut Pg17_18Queries'te vardi ve katologa sorgulanmadan tasinmisti;
        // dis inceleme yakaladi.
        for (String v : new String[]{"1.11", "1.12"}) {
            String sql = catalog.buildSelectList(PgssVersion.of(v));
            String blkRead = lineFor(sql, "as blk_read_time");
            assertThat(blkRead).as("surum " + v).doesNotContain("temp_blk_read_time");

            String blkWrite = lineFor(sql, "as blk_write_time");
            assertThat(blkWrite).as("surum " + v).doesNotContain("temp_blk_write_time");
        }
        // temp kendi kolonunda duruyor — kaybolmadi, yalnizca cift sayilmiyor.
        assertThat(catalog.buildSelectList(PgssVersion.of("1.11")))
            .contains("temp_blk_read_time as temp_blk_read_time");
    }

    @Test
    void derivedColumnsSurviveTheDefensiveModeInsteadOfSilentlyZeroing() {
        // Ilk surumde turetme serbest SQL ile yazilmisti ve savunmaci modda
        // uretilemiyordu; blk_read_time 1.11+ uzerinde SESSIZCE sifira
        // duruyordu. Kod yorumu bunun kaydedildigini soyluyordu ama boyle bir
        // kayit yoktu. Sinirli derive islemleri bu kaybi ortadan kaldirdi.
        String unknown = catalog.buildSelectList(null);
        String blkRead = lineFor(unknown, "as blk_read_time");
        assertThat(blkRead)
            .contains("(j->>'blk_read_time')")          // 1.4-1.10 yolu
            .contains("(j->>'shared_blk_read_time')")   // 1.11+ turetmesi
            .contains("(j->>'local_blk_read_time')")
            .doesNotContain("temp_blk_read_time");
    }

    @Test
    void theInfoViewGateComesFromTheExtensionVersionNotThePgFamily() {
        // pg_stat_statements_info pgss 1.9'da geldi. Karar PG ailesinden
        // veriliyordu (supportsPgssInfo yalnizca Pg14_16Queries'te true) ve
        // PG14+ sunucuda pgss 1.8 kalmissa sorgu patliyordu.
        assertThat(catalog.supportsInfoView(PgssVersion.of("1.8"))).isFalse();
        assertThat(catalog.supportsInfoView(PgssVersion.of("1.9"))).isTrue();
        assertThat(catalog.supportsInfoView(PgssVersion.of("1.11"))).isTrue();
        // Surum bilinmiyorsa okunamayacagi varsayilir: olmayan bir view'i
        // sorgulamaktan iyidir.
        assertThat(catalog.supportsInfoView(null)).isFalse();
    }

    /** Uretilen SELECT listesinden belirli bir hedefin satirini alir. */
    private static String lineFor(String selectList, String marker) {
        for (String line : selectList.split(",\n")) {
            if (line.contains(marker)) return line;
        }
        throw new AssertionError("satir bulunamadi: " + marker);
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
    void theOneTwelveBoundaryIsMeasuredNotGuessed() {
        // OLCULDU 2026-09-14, postgres:18.6: 1.12, 1.11'e gore TAM OLARAK uc
        // kolon ekliyor ve hicbir sey kaldirmiyor.
        //
        // Once verified: false idi ve to_jsonb ile guvenli okunuyordu. Uretim
        // verisi tek basina sinirlamiyordu: PG18 satirlarinda deger sifirdan
        // farkli geliyordu ama bu "PG18 instance'larinda var" demekti, "pgss
        // 1.12'de var" demek degil — surumu pg_major'dan cikarmak bu isin
        // kaldirdigi karistirmanin ta kendisi. Sinir, extversion merkezi kayda
        // yazildiktan (V119) ve kolon listesi sayildiktan sonra kapandi.
        String v11 = catalog.buildSelectList(PgssVersion.of("1.11"));
        String v12 = catalog.buildSelectList(PgssVersion.of("1.12"));

        for (String col : new String[]{
                "parallel_workers_to_launch", "parallel_workers_launched", "wal_buffers_full"}) {
            assertThat(lineFor(v11, "as " + col))
                .as(col + " 1.11'de yok")
                .doesNotContain("(j->>")
                .contains("0::");
            assertThat(lineFor(v12, "as " + col))
                .as(col + " 1.12'de dogrudan okunur")
                .isEqualTo("  " + col + " as " + col);
        }
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
