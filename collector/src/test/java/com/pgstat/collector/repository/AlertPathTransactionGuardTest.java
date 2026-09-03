package com.pgstat.collector.repository;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * DEGISMEZ: Alarm yazma yolunda hicbir metot bir transaction'a katilmaz.
 * ops.alert ve ops.alert_episode yazimlari ayri autocommit ifadeleridir.
 *
 * ---------------------------------------------------------------------------
 * NEDEN BU TEST VAR
 * ---------------------------------------------------------------------------
 * Dis inceleme sunu sordu: golge yazimi try/catch'e almak yetmez, cunku epizot
 * yazimi ana alarm yazimiyla AYNI transaction'daysa SQL hatasi transaction'i
 * 'aborted' duruma sokar; istisna yakalansa bile ana alarm COMMIT EDILEMEZ.
 *
 * Bu kod tabaninda bugun ortak transaction yok — dogrulandi 2026-09-03:
 * collector genelinde @Transactional sifir eslesme, TransactionTemplate /
 * PlatformTransactionManager kullanimi yok, Hikari'de auto-commit: false yok
 * (varsayilan autoCommit=true). Yani her jdbc cagrisi kendi transaction'i ve
 * incelemenin tarif ettigi senaryo gerceklesemez.
 *
 * AMA BU GARANTI KAZARA, TASARLANMIS DEGIL. Biri yarin evaluate()'e
 * @Transactional eklerse — toplu alarm yazimi icin akla yatkin bir hamle —
 * golge yazim sessizce o transaction'a katilir ve senaryo gercek olur. Kazara
 * dogru olan bir sey, degismez sayilamaz; test edilmeyen bir degismez de
 * degismez degildir.
 *
 * ---------------------------------------------------------------------------
 * NEDEN ENTEGRASYON TESTI DEGIL
 * ---------------------------------------------------------------------------
 * Gercek DB transaction davranisini dogrulayan bir entegrasyon testi daha
 * guclu olurdu, ama bu projede Testcontainers/H2 gibi bir altyapi HIC YOK;
 * mevcut testlerin tamami saf birim testi. Boyle bir altyapiyi tek bir
 * ozelligin yan urunu olarak eklemek dogru degil — ayri bir board maddesi.
 *
 * Bu kaynak tarayan test, tam olarak korkulan regresyonu (alarm yoluna
 * @Transactional girmesi) Docker bagimliligi olmadan yakalar. Yakalayamadigi
 * sey, transaction'in baska bir yoldan (elle Connection yonetimi) gelmesi;
 * bu yuzden TransactionTemplate ve setAutoCommit de taraniyor.
 */
class AlertPathTransactionGuardTest {

    /** Alarm yazma yolundaki siniflar — hepsi ops.alert veya ops.alert_episode yazar. */
    private static final List<String> ALERT_PATH_SOURCES = List.of(
        "src/main/java/com/pgstat/collector/repository/AlertRepository.java",
        "src/main/java/com/pgstat/collector/repository/AlertEpisodeRepository.java",
        "src/main/java/com/pgstat/collector/service/AlertService.java",
        "src/main/java/com/pgstat/collector/service/AlertRuleEvaluator.java",
        "src/main/java/com/pgstat/collector/service/LongRunningQueryEvaluator.java",
        "src/main/java/com/pgstat/collector/service/SlotLifecycleEvaluator.java",
        "src/main/java/com/pgstat/collector/service/XidFreezeEvaluator.java"
    );

    /**
     * Transaction'a katilmaya yol acan isaretler. Yorum satirlarinda gecmeleri
     * beklenir (bu dosyanin kendisi gibi), o yuzden yorumlar ayiklaniyor.
     */
    private static final List<String> FORBIDDEN = List.of(
        "@Transactional",
        "TransactionTemplate",
        "PlatformTransactionManager",
        "setAutoCommit"
    );

    @Test
    void noClassOnTheAlertWritePathJoinsATransaction() throws IOException {
        List<String> violations = new ArrayList<>();

        for (String relative : ALERT_PATH_SOURCES) {
            Path path = Path.of(relative);
            if (!Files.exists(path)) {
                // Sinif tasindiysa/silindiyse test sessizce gecmemeli: liste
                // guncellenmedigi icin korumasiz kalan bir dosya olabilir.
                violations.add(relative + " -> dosya bulunamadi, liste guncellenmeli");
                continue;
            }
            String source = stripComments(Files.readString(path, StandardCharsets.UTF_8));
            for (String marker : FORBIDDEN) {
                if (source.contains(marker)) {
                    violations.add(relative + " -> " + marker);
                }
            }
        }

        assertThat(violations)
            .as("Alarm yazma yolu transaction'a katilmamali: ops.alert ve "
              + "ops.alert_episode ayri autocommit ifadeleri olmali. Bir "
              + "transaction eklenirse epizot yazimindaki SQL hatasi "
              + "transaction'i abort eder ve ANA ALARM COMMIT EDILEMEZ — "
              + "istisna yakalansa bile. Bunu bilerek degistiriyorsan "
              + "docs/alert-lifecycle-design.md bolum 7'yi guncelle.")
            .isEmpty();
    }

    /** Blok ve satir yorumlarini ayiklar; string literal'lere dokunmaz. */
    private static String stripComments(String source) {
        return source
            .replaceAll("(?s)/\\*.*?\\*/", "")
            .replaceAll("(?m)^\\s*//.*$", "");
    }
}
