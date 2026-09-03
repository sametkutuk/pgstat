package com.pgstat.collector.repository;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Alarm ihlal epizodu yazimi (PGSTAT-P0-048, Adim 1).
 *
 * Bir EPIZOT, bir ihlalin kimligi belli tek surekliligidir: bir kez acilir,
 * yeniden degerlendirmelerden sag cikar, kosul gectiginde kapanir; sonraki
 * ihlal yeni bir epizottur. ops.alert bunu tutamiyor cunku bir olay tablosu
 * gibi kullanilan bir durum tablosu.
 *
 * BU SURUMDE EPIZOT YALNIZCA YAZILIR, OKUNMAZ. Hicbir alarm, bildirim veya UI
 * karari buna dayanmaz. Golge donemi bitmeden epizoda dayanan bir karar vermek,
 * dogrulanmamis bir veriye guvenmek olurdu.
 *
 * ---------------------------------------------------------------------------
 * GOLGE YAZIM SOZLESMESI
 * ---------------------------------------------------------------------------
 * 1. Bu siniftaki hicbir public metot ISTISNA FIRLATMAZ. Alarm uretimi, epizot
 *    yaziminin basarisina bagli olamaz.
 *
 * 2. Ama hata GIZLENMEZ: WARN seviyesinde stack trace ile loglanir ve sayac
 *    artar. Bu haftanin dersinin iki yuzu birden: sessiz bir catch isi gizler
 *    (izleme yolu 14 saat sessizce hicbir satir yazmadi), gizlenmemis bir
 *    istisna da alarm uretimini keser. Ikisi de kabul edilemez.
 *
 * 3. AYRI TRANSACTION. Dis inceleme hakli olarak sunu sordu: yakalanan bir
 *    istisna yetmez, cunku epizot yazimi ana alarm yazimiyla AYNI
 *    transaction'daysa SQL hatasi transaction'i 'aborted' duruma sokar ve ana
 *    alarm commit edilemez.
 *
 *    Bu kod tabaninda bugun ortak transaction YOK — dogrulandi: collector
 *    genelinde @Transactional sifir eslesme, TransactionTemplate /
 *    PlatformTransactionManager kullanimi yok, Hikari'de auto-commit: false
 *    yok (varsayilan autoCommit=true). Yani her jdbc cagrisi kendi
 *    transaction'i.
 *
 *    AMA BU GARANTI KAZARA, TASARLANMIS DEGIL. Biri yarin evaluate()'e
 *    @Transactional eklerse — toplu alarm yazimi icin akla yatkin bir hamle —
 *    golge yazim sessizce o transaction'a katilir ve incelemenin tarif ettigi
 *    senaryo gercek olur. Bu yuzden degismez yazili hale getirildi ve
 *    AlertPathTransactionGuardTest ile korunuyor.
 *
 * Tasarim: docs/alert-lifecycle-design.md
 */
@Repository
public class AlertEpisodeRepository {

    private static final Logger log = LoggerFactory.getLogger(AlertEpisodeRepository.class);

    /**
     * last_confirmed_at yenileme araligi.
     *
     * Epizot satiri her degerlendirmede degil, YALNIZCA anlamli bir sey
     * degistiginde yazilir (durum, severity) ya da bu sure gectiginde. Gerekce
     * V112'de olculdu: her degerlendirmede yazilan bir damga, dim.statement_series
     * tablosunu 942 MB'a cikarmisti. Buradaki kazanc HOT degil (bu tabloda sik
     * degisen kolonlarin hicbiri indeksli degil) — dogrudan YAZMA SAYISI.
     *
     * Sonucu: observation_count "degerlendirme sayisi" degil "teyit yazimi
     * sayisi"dir. Bu bilincli; occurrence_count'un degerlendirme sayarak
     * yaniltici olmasi zaten sikayetin bir parcasiydi.
     */
    private static final String CONFIRM_REFRESH_INTERVAL = "1 hour";

    private final JdbcTemplate jdbc;

    /** Golge yazim hatasi sayaci — sessizce kaybolmamali. */
    private final AtomicLong writeFailures = new AtomicLong();
    /** Kimlik beklenip gelmedigi icin epizot acilamayan gozlem sayisi. */
    private final AtomicLong missingIdentityCount = new AtomicLong();

    private volatile Instant lastFailureAt;
    private volatile String lastFailureMessage;

    public AlertEpisodeRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Epizot durumlari. */
    public static final String STATE_BREACHING = "confirmed_breaching";
    public static final String STATE_HEALTHY   = "confirmed_healthy";
    public static final String STATE_UNKNOWN   = "unknown";

    /** Kapanma sebepleri. */
    public static final String CLOSE_RESOLVED         = "resolved";
    public static final String CLOSE_IDENTITY_CHANGED = "identity_changed";
    public static final String CLOSE_SUPERSEDED       = "superseded";
    public static final String CLOSE_STALE_TIMEOUT    = "stale_timeout";

    /**
     * Bir gozlem.
     *
     * @param alertKey           epizot kimligi; ops.alert.alert_key ile ayni
     * @param alertCode          alarm kodu
     * @param alertSource        'system' | 'user_rule' | 'adaptive' | 'legacy'
     * @param instancePk         instance (null olabilir)
     * @param dbid               veritabani oid'i; relid TEK BASINA benzersiz degil
     * @param relid              tablo oid'i (yalnizca tablo bazli kurallar)
     * @param relationGeneration (relfilenode, reltablespace) metin gosterimi
     * @param expectsGeneration  bu kural fiziksel nesil BEKLIYOR mu? true olup
     *                           relationGeneration null gelirse epizot ACILMAZ
     * @param state              STATE_* sabitlerinden biri
     * @param severity           gozlem anindaki severity (null olabilir)
     * @param sampleTs           gozlemin ait oldugu an; gec gelen veya
     *                           tekrarlanan ornek durumu ilerletmez
     */
    public record Observation(
        String alertKey,
        String alertCode,
        String alertSource,
        Long instancePk,
        Long dbid,
        Long relid,
        String relationGeneration,
        boolean expectsGeneration,
        String state,
        String severity,
        Instant sampleTs
    ) {}

    /**
     * Gozlemi kaydeder. ASLA ISTISNA FIRLATMAZ.
     *
     * confirmed_healthy epizodu KAPATIR. unknown ne kapatir ne de ihlal saatini
     * ilerletir — veri yoklugu saglik kaniti degildir.
     */
    public void observe(Observation obs) {
        try {
            if (obs == null || obs.alertKey() == null || obs.state() == null) {
                return;
            }

            // KIMLIK EKSIK: epizot acilmaz. Uydurulmus kimlikle acilan bir
            // epizot, gercek kimlik sonradan geldiginde cakisir ve iki ayri
            // ihlali birbirine karistirir. Golge doneminde sayac + WARN yeterli;
            // epizot karar vermeye basladiginda (Adim 2) kalici kayit gerekecek.
            if (obs.expectsGeneration() && obs.relationGeneration() == null) {
                long n = missingIdentityCount.incrementAndGet();
                log.warn("Epizot acilmadi, fiziksel nesil eksik: alert_key={} (toplam {})",
                    obs.alertKey(), n);
                return;
            }

            if (STATE_HEALTHY.equals(obs.state())) {
                // Durum da YAZILIR. Once yalnizca closed_at/close_reason
                // yaziliyordu ve satirin state'i 'confirmed_breaching' olarak
                // kaliyordu: kapali bir epizot, kapandigi anda kosulun DOGRU
                // oldugunu soyluyordu. Kapanma sebebi ile kapanis anindaki
                // durum ayri iki sey ve ikisi de kaydedilmeli — "cozuldu"
                // ile "kimlik degisti" ayni close_reason'a sahip olamaz ama
                // ayni state'e de sahip olmamali.
                close(obs.alertKey(), CLOSE_RESOLVED, STATE_HEALTHY);
                return;
            }

            // NESIL DEGISIMI: eski epizot kapanir, yenisi acilir. Nesil aktif
            // tekillik anahtarinda DEGIL (bkz. V114 yorumu), o yuzden burada
            // acikca ele aliniyor. Yalnizca nesil BEKLENEN kurallarda calisir;
            // aksi halde nesli null olan her alarmi her turda kapatirdi.
            if (obs.expectsGeneration()) {
                closeOnGenerationChange(obs.alertKey(), obs.relationGeneration());
            }

            upsert(obs);

        } catch (Exception e) {
            recordFailure("observe alert_key=" + (obs == null ? "null" : obs.alertKey()), e);
        }
    }

    /**
     * Acik epizodu kapatir. ASLA ISTISNA FIRLATMAZ.
     * Zaten kapaliysa veya hic yoksa hicbir sey yapmaz.
     */
    public void close(String alertKey, String reason) {
        close(alertKey, reason, null);
    }

    /**
     * Acik epizodu kapatir ve istege bagli olarak kapanis durumunu yazar.
     * ASLA ISTISNA FIRLATMAZ.
     *
     * @param finalState null ise mevcut durum korunur. Yalnizca kosulun
     *                   gectigi DOGRULANDIGINDA confirmed_healthy gecilir;
     *                   kimlik degisimi ve zaman asimi kapanislarinda kosul
     *                   hakkinda hicbir sey ogrenmedik, o yuzden durum
     *                   degistirilmez — bunlari "iyilesti" diye kaydetmek,
     *                   veri yoklugunu saglik kaniti saymak olurdu.
     */
    public void close(String alertKey, String reason, String finalState) {
        try {
            if (alertKey == null) return;
            jdbc.update("""
                update ops.alert_episode
                set closed_at = now(),
                    close_reason = ?,
                    state = coalesce(?, state),
                    last_confirmed_at = now()
                where alert_key = ?
                  and closed_at is null
                """, reason == null ? CLOSE_RESOLVED : reason, finalState, alertKey);
        } catch (Exception e) {
            recordFailure("close alert_key=" + alertKey, e);
        }
    }

    /**
     * Acik epizodun severity'sini gunceller. ASLA ISTISNA FIRLATMAZ.
     *
     * YALNIZCA GUNCELLER, EPIZOT ACMAZ. AlertRuleEvaluator'in severity
     * yamalari her zaman acilmis bir alarmin uzerine gelir; epizot yoksa
     * uydurma bir alert_code ile satir acmak, veriyi kirletmek olurdu.
     *
     * max_severity dusen severity'de geri gitmez: "bu bir ara critical
     * olmustu" cumlesi kurulabilir kalmali.
     */
    public void observeSeverity(String alertKey, String severity) {
        try {
            if (alertKey == null) return;
            jdbc.update("""
                update ops.alert_episode
                set severity = ?,
                    max_severity = case
                      when max_severity is null then ?
                      when ? = 'critical' or max_severity = 'critical' then 'critical'
                      when ? = 'error' or max_severity = 'error' then 'error'
                      when ? = 'warning' or max_severity = 'warning' then 'warning'
                      else max_severity
                    end,
                    last_confirmed_at = now()
                where alert_key = ?
                  and closed_at is null
                  and severity is distinct from ?
                """, severity, severity, severity, severity, severity, alertKey, severity);
        } catch (Exception e) {
            recordFailure("observeSeverity alert_key=" + alertKey, e);
        }
    }

    /**
     * Fiziksel nesil degistiyse acik epizodu kapatir.
     *
     * SET TABLESPACE blok blok kopyalar ve sismeyi KORUR, yani nesil degisimi
     * tek basina sikismanin kaniti degil — ama yine de fiziksel olarak baska
     * bir nesnedir ve eski nesildeki ihlal yenisinde devam eden bir ihlal
     * sayilamaz.
     */
    private void closeOnGenerationChange(String alertKey, String generation) {
        if (generation == null) return;
        jdbc.update("""
            update ops.alert_episode
            set closed_at = now(),
                close_reason = ?,
                last_confirmed_at = now()
            where alert_key = ?
              and closed_at is null
              and relation_generation is not null
              and relation_generation is distinct from ?
            """, CLOSE_IDENTITY_CHANGED, alertKey, generation);
    }

    /**
     * Epizodu acar ya da gunceller.
     *
     * DO UPDATE'in WHERE'i iki isi birden yapiyor:
     *   - sample_ts sirasi: gec gelen/tekrarlanan ornek durumu ILERLETMEZ
     *   - yazma azaltma: anlamli bir degisiklik yoksa ve teyit damgasi henuz
     *     taze ise satira hic dokunulmaz
     */
    private void upsert(Observation obs) {
        java.sql.Timestamp sampleTs = obs.sampleTs() == null
            ? new java.sql.Timestamp(System.currentTimeMillis())
            : java.sql.Timestamp.from(obs.sampleTs());

        boolean breaching = STATE_BREACHING.equals(obs.state());

        jdbc.update("""
            insert into ops.alert_episode (
              alert_key, alert_code, alert_source, instance_pk,
              dbid, relid, relation_generation, identity_status,
              state, severity, max_severity,
              first_observed_breaching_at,
              last_confirmed_at, last_sample_ts, observation_count,
              backfilled
            )
            values (?, ?, ?, ?, ?, ?, ?, 'complete', ?, ?, ?,
                    case when ?::boolean then ?::timestamptz else null end,
                    now(), ?, 1,
                    -- BACKFILLED: alarm bizden once acilmis mi? Oyleyse bu
                    -- epizodun ihlal saati GEC baslamis demektir ve kidemi
                    -- oldugundan genc gorunur. Sabit false yazmak, hicbir zaman
                    -- dogru olmayan bir kolon uretirdi — gozlem verisinde yalan,
                    -- tam da duzeltmeye calistigimiz sey.
                    coalesce((select a.first_seen_at < now() - interval '1 minute'
                                from ops.alert a where a.alert_key = ?), false))
            on conflict (alert_key) where closed_at is null do update
            set state = excluded.state,
                severity = excluded.severity,
                -- Epizot boyunca gorulen en yuksek severity. Dusen severity
                -- kidemi silmemeli: "bu bir ara critical olmustu" cumlesi
                -- kurulabilir kalmali.
                max_severity = case
                  when ops.alert_episode.max_severity is null then excluded.severity
                  when excluded.severity = 'critical' then 'critical'
                  when ops.alert_episode.max_severity = 'critical' then 'critical'
                  when excluded.severity = 'error' or ops.alert_episode.max_severity = 'error' then 'error'
                  when excluded.severity = 'warning' or ops.alert_episode.max_severity = 'warning' then 'warning'
                  else ops.alert_episode.max_severity
                end,
                -- YALNIZCA yanlis->dogru gecisinde yazilir. Bir kez damgalandiktan
                -- sonra yeniden degerlendirme ASLA uzerine yazmaz; kidem
                -- severity'sinin (Adim 2) tek dayanagi bu.
                first_observed_breaching_at = coalesce(
                  ops.alert_episode.first_observed_breaching_at,
                  excluded.first_observed_breaching_at),
                relation_generation = coalesce(excluded.relation_generation,
                                               ops.alert_episode.relation_generation),
                dbid = coalesce(excluded.dbid, ops.alert_episode.dbid),
                relid = coalesce(excluded.relid, ops.alert_episode.relid),
                instance_pk = coalesce(excluded.instance_pk, ops.alert_episode.instance_pk),
                last_sample_ts = excluded.last_sample_ts,
                last_confirmed_at = now(),
                observation_count = ops.alert_episode.observation_count + 1
            where excluded.last_sample_ts > ops.alert_episode.last_sample_ts
              and (ops.alert_episode.state is distinct from excluded.state
                   or ops.alert_episode.severity is distinct from excluded.severity
                   or ops.alert_episode.last_confirmed_at < now() - ?::interval)
            """,
            obs.alertKey(), obs.alertCode(), obs.alertSource(), obs.instancePk(),
            obs.dbid(), obs.relid(), obs.relationGeneration(),
            obs.state(), obs.severity(), obs.severity(),
            breaching, sampleTs,
            sampleTs,
            obs.alertKey(),
            CONFIRM_REFRESH_INTERVAL
        );
    }

    /**
     * Hatayi WARN + stack trace ile kaydeder ve sayaci artirir.
     *
     * DEBUG DEGIL. Bu hafta iki ayri hata tam da DEBUG'a yazildigi icin
     * haftalarca fark edilmedi.
     */
    private void recordFailure(String context, Exception e) {
        long n = writeFailures.incrementAndGet();
        lastFailureAt = Instant.now();
        lastFailureMessage = e.getMessage();
        log.warn("Epizot golge yazimi basarisiz ({}), toplam hata: {}. "
               + "Ana alarm akisi ETKILENMEDI.", context, n, e);
    }

    /** Golge yazim hatasi sayisi. Sistem sagligi bunu okuyacak (Adim 3). */
    public long getWriteFailures() {
        return writeFailures.get();
    }

    /** Kimlik eksikligi yuzunden acilamayan epizot sayisi. */
    public long getMissingIdentityCount() {
        return missingIdentityCount.get();
    }

    public Instant getLastFailureAt() {
        return lastFailureAt;
    }

    public String getLastFailureMessage() {
        return lastFailureMessage;
    }
}
