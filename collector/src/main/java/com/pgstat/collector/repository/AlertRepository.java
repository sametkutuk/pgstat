package com.pgstat.collector.repository;

import com.pgstat.collector.model.AlertCode;
import com.pgstat.collector.service.NotificationService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.util.List;

/**
 * ops.alert tablosu icin upsert ve resolve islemleri.
 * Mimari dok: satir 3156-3205
 */
@Repository
public class AlertRepository {

    /**
     * Bildirim modu — ayni alert_key tekrar upsert edildiginde bildirim atilsin mi?
     *   ALWAYS     : her upsert'te bildir (mevcut davranis; spam korumasi NotificationService'te).
     *   FIRST_ONLY : sadece yeni alert, reopen (resolved/acknowledged -> open) veya severity
     *                degisiminde bildir. Ayni severity'de acik kalan alert sessiz kalir.
     *                (XID warning gibi: ilk kez + critical'e yukselince bildir, arada sus.)
     */
    /**
     * ALWAYS      — her upsert'te bildir.
     * FIRST_ONLY  — ayni severity'de acik kalan alert sessiz; yeni/reopen/
     *               severity-degisimi bildirilir.
     * DEFERRED    — bu upsert hic bildirim uretmez. Cagiran taraf, bir
     *               degerlendirmede acilan alert'leri toplayip TEK ozet
     *               bildirim gonderir. Granular kurallar kayit basina ayri
     *               alert actigi icin gerekli: bes bozuk tablo bes ayri
     *               ops.alert satiri olusturur ama tek mesaj gonderilir
     *               (musteri karari 2026-08-28).
     */
    public enum NotifyMode { ALWAYS, FIRST_ONLY, DEFERRED }

    private static final Logger log = LoggerFactory.getLogger(AlertRepository.class);

    private final JdbcTemplate jdbc;
    private NotificationService notificationService;

    /**
     * Ihlal epizodu golge yazimi (PGSTAT-P0-048, Adim 1).
     *
     * BU SURUMDE YALNIZCA YAZILIR. Bu siniftaki hicbir karar epizoda bakmaz;
     * alarm, bildirim ve UI davranisi degismez. Amac, epizot modelini gercek
     * trafikle doldurup cift yonlu karsilastirma sorgusuyla dogrulamak.
     *
     * Sozlesme: episodes.* metotlari ISTISNA FIRLATMAZ (bkz.
     * AlertEpisodeRepository). Yine de her cagri ana akisin SONUNDA, alert_id
     * elde edildikten sonra yapilir — boylece epizot tarafinda beklenmedik bir
     * sey olsa bile alarm satiri coktan yazilmis olur.
     */
    private final AlertEpisodeRepository episodes;

    public AlertRepository(JdbcTemplate jdbc, AlertEpisodeRepository episodes) {
        this.jdbc = jdbc;
        this.episodes = episodes;
    }

    /** Circular dependency'den kaçınmak için setter injection */
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    public void setNotificationService(NotificationService notificationService) {
        this.notificationService = notificationService;
    }

    /**
     * Alert olusturur veya mevcudu gunceller (ON CONFLICT ile idempotent).
     * Ayni alert_key tekrar gelirse: occurrence_count artar, last_seen_at guncellenir.
     * Resolved durumundaysa tekrar 'open' olur.
     *
     * @param alertKey         benzersiz anahtar (ornek: "connection_failure:instance:42")
     * @param alertCode        AlertCode enum degeri
     * @param instancePk       ilgili instance (null olabilir — job seviyesi alert'ler icin)
     * @param serviceGroup     service grubu (null olabilir)
     * @param systemIdentifier PG system identifier (null olabilir)
     * @param title            alert basligi
     * @param message          detayli mesaj
     * @param detailsJson      ek JSON detay (null olabilir)
     * @return olusturulan veya guncellenen alert_id
     */
    public long upsert(String alertKey, AlertCode alertCode, Long instancePk,
                       String serviceGroup, Long systemIdentifier,
                       String title, String message, String detailsJson) {
        return upsert(alertKey, alertCode, instancePk, serviceGroup, systemIdentifier,
            title, message, detailsJson, NotifyMode.ALWAYS);
    }

    /**
     * upsert + bildirim modu. FIRST_ONLY ile ayni severity'de acik kalan alert sessiz kalir;
     * yeni/reopen/severity-degisimi durumunda bildirilir.
     */
    public long upsert(String alertKey, AlertCode alertCode, Long instancePk,
                       String serviceGroup, Long systemIdentifier,
                       String title, String message, String detailsJson, NotifyMode notifyMode) {
        // FIRST_ONLY icin: upsert'ten ONCE mevcut alert'in durumunu oku.
        // Yeni satir / reopen / severity-degisimi -> bildir, aksi -> sus.
        boolean shouldNotify = true;
        if (notifyMode == NotifyMode.FIRST_ONLY) {
            shouldNotify = decideFirstOnlyNotify(alertKey, alertCode.getDefaultSeverity());
        }

        // source_component'a göre alert_source belirle
        // 'system' (SystemHealth) → 'system', 'rule' (user-defined) → 'user_rule'
        String src = alertCode.getSourceComponent();
        String alertSource;
        if ("adaptive".equals(src)) {
            alertSource = "adaptive";
        } else if ("rule".equals(src)) {
            alertSource = "user_rule";
        } else {
            alertSource = "system";
        }
        long alertId = jdbc.queryForObject("""
            insert into ops.alert (
              alert_key,
              alert_code,
              severity,
              status,
              source_component,
              instance_pk,
              service_group,
              system_identifier,
              first_seen_at,
              last_seen_at,
              occurrence_count,
              title,
              message,
              details_json,
              alert_source
            )
            values (?, ?, ?, 'open', ?, ?, ?, ?, now(), now(), 1, ?, ?, ?::jsonb, ?)
            on conflict (alert_key) do update
            set severity = excluded.severity,
                status = case
                  when ops.alert.status in ('resolved', 'acknowledged') then 'open'
                  else ops.alert.status
                end,
                acknowledged_at = case
                  when ops.alert.status = 'acknowledged' then null
                  else ops.alert.acknowledged_at
                end,
                instance_pk = coalesce(excluded.instance_pk, ops.alert.instance_pk),
                service_group = coalesce(excluded.service_group, ops.alert.service_group),
                system_identifier = coalesce(excluded.system_identifier, ops.alert.system_identifier),
                last_seen_at = now(),
                title = excluded.title,
                message = excluded.message,
                details_json = excluded.details_json,
                alert_source = excluded.alert_source,
                occurrence_count = ops.alert.occurrence_count + 1,
                resolved_at = null
            returning alert_id
            """,
            Long.class,
            alertKey,
            alertCode.getCode(),
            alertCode.getDefaultSeverity(),
            alertCode.getSourceComponent(),
            instancePk,
            serviceGroup,
            systemIdentifier,
            title,
            message,
            detailsJson,
            alertSource
        );

        // Bildirim gönder (FIRST_ONLY modunda sadece yeni/reopen/severity-degisiminde)
        if (shouldNotify) {
            fireNotification(alertId, alertKey, alertCode.getCode(), alertCode.getDefaultSeverity(), instancePk, title, message);
        }

        shadowObserve(alertKey, alertCode.getCode(), alertSource, instancePk,
            alertCode.getDefaultSeverity());
        return alertId;
    }

    /**
     * FIRST_ONLY modu icin bildirim karari: upsert'ten ONCE mevcut alert durumuna bak.
     *   - Alert yoksa (yeni)                       -> bildir
     *   - Mevcut status 'resolved'/'acknowledged'  -> reopen olacak, bildir
     *   - Mevcut severity yeni severity'den farkli  -> severity degisti, bildir
     *   - Aksi (zaten 'open', ayni severity)        -> sus
     */
    private boolean decideFirstOnlyNotify(String alertKey, String newSeverity) {
        try {
            var rows = jdbc.query(
                "select status, severity from ops.alert where alert_key = ?",
                (rs, n) -> new String[]{ rs.getString("status"), rs.getString("severity") },
                alertKey
            );
            if (rows.isEmpty()) {
                return true; // yeni alert
            }
            String status = rows.get(0)[0];
            String severity = rows.get(0)[1];
            if ("resolved".equals(status) || "acknowledged".equals(status)) {
                return true; // reopen
            }
            return !java.util.Objects.equals(severity, newSeverity); // severity degisti mi?
        } catch (Exception e) {
            return true; // emin degilsek bildir (sessiz kalmaktansa)
        }
    }

    /**
     * Adaptive kaynakli, severity'si DINAMIK (kullanici secimli) alert upsert'i.
     * alert_source = 'adaptive'. notifyMode FIRST_ONLY ile acik kaldikca spam yapmaz.
     * database_inaccessible gibi severity'si kullanici tarafindan secilen alertler icin.
     */
    public long upsertAdaptiveWithSeverity(String alertKey, AlertCode alertCode, String severity,
                                           Long instancePk, String title, String message,
                                           String detailsJson, NotifyMode notifyMode, boolean notify) {
        // notify=false: alert UI'da gorunur/guncellenir ama bildirim (Telegram/email)
        // GONDERILMEZ. notify=true ise notifyMode'a gore karar verilir.
        boolean shouldNotify = notify;
        if (shouldNotify && notifyMode == NotifyMode.FIRST_ONLY) {
            shouldNotify = decideFirstOnlyNotify(alertKey, severity);
        }
        long alertId = jdbc.queryForObject("""
            insert into ops.alert (
              alert_key, alert_code, severity, status, source_component,
              instance_pk, first_seen_at, last_seen_at, occurrence_count,
              title, message, details_json, alert_source
            )
            values (?, ?, ?, 'open', ?, ?, now(), now(), 1, ?, ?, ?::jsonb, 'adaptive')
            on conflict (alert_key) do update
            set severity = excluded.severity,
                status = case
                  when ops.alert.status in ('resolved', 'acknowledged') then 'open'
                  else ops.alert.status
                end,
                acknowledged_at = case
                  when ops.alert.status = 'acknowledged' then null
                  else ops.alert.acknowledged_at
                end,
                last_seen_at = now(),
                title = excluded.title,
                message = excluded.message,
                details_json = excluded.details_json,
                occurrence_count = ops.alert.occurrence_count + 1,
                resolved_at = null
            returning alert_id
            """,
            Long.class,
            alertKey, alertCode.getCode(), severity, alertCode.getSourceComponent(),
            instancePk, title, message, detailsJson
        );

        if (shouldNotify) {
            fireNotification(alertId, alertKey, alertCode.getCode(), severity, instancePk, title, message);
        }
        shadowObserve(alertKey, alertCode.getCode(), "adaptive", instancePk, severity);
        return alertId;
    }

    /**
     * Kullanici tanimli kural alert'i — severity dinamik, rule_id kaydedilir.
     */
    public long upsertWithSeverity(String alertKey, AlertCode alertCode, String severity,
                                   Long instancePk, String serviceGroup,
                                   String title, String message) {
        return upsertWithSeverity(alertKey, alertCode, severity, instancePk, serviceGroup, title, message, null);
    }

    public long upsertWithSeverity(String alertKey, AlertCode alertCode, String severity,
                                   Long instancePk, String serviceGroup,
                                   String title, String message, Long ruleId) {
        return upsertWithSeverity(alertKey, alertCode, severity, instancePk, serviceGroup,
            title, message, ruleId, null);
    }

    public long upsertWithSeverity(String alertKey, AlertCode alertCode, String severity,
                                   Long instancePk, String serviceGroup,
                                   String title, String message, Long ruleId, String detailsJson) {
        return upsertWithSeverity(alertKey, alertCode, severity, instancePk, serviceGroup,
            title, message, ruleId, detailsJson, NotifyMode.ALWAYS);
    }

    public long upsertWithSeverity(String alertKey, AlertCode alertCode, String severity,
                                   Long instancePk, String serviceGroup,
                                   String title, String message, Long ruleId, String detailsJson,
                                   NotifyMode notifyMode) {
        String alertSource = ruleId != null ? "user_rule" : "system";
        long alertId = jdbc.queryForObject("""
            insert into ops.alert (
              alert_key, alert_code, severity, status, source_component,
              instance_pk, service_group, first_seen_at, last_seen_at,
              occurrence_count, title, message, rule_id, details_json, alert_source
            )
            values (?, ?, ?, 'open', ?, ?, ?, now(), now(), 1, ?, ?, ?, ?::jsonb, ?)
            on conflict (alert_key) do update
            set severity = excluded.severity,
                status = case
                  when ops.alert.status in ('resolved', 'acknowledged') then 'open'
                  else ops.alert.status
                end,
                acknowledged_at = case
                  when ops.alert.status = 'acknowledged' then null
                  else ops.alert.acknowledged_at
                end,
                instance_pk = coalesce(excluded.instance_pk, ops.alert.instance_pk),
                service_group = coalesce(excluded.service_group, ops.alert.service_group),
                last_seen_at = now(),
                title = excluded.title,
                message = excluded.message,
                rule_id = coalesce(excluded.rule_id, ops.alert.rule_id),
                details_json = excluded.details_json,
                alert_source = excluded.alert_source,
                occurrence_count = ops.alert.occurrence_count + 1,
                resolved_at = null
            returning alert_id
            """,
            Long.class,
            alertKey, alertCode.getCode(), severity, alertCode.getSourceComponent(),
            instancePk, serviceGroup, title, message, ruleId, detailsJson, alertSource
        );

        // DEFERRED modda bildirim burada gonderilmez — cagiran taraf
        // degerlendirme sonunda tek ozet bildirim gonderir.
        if (notifyMode != NotifyMode.DEFERRED) {
            fireNotification(alertId, alertKey, alertCode.getCode(), severity, instancePk, title, message);
        }

        shadowObserve(alertKey, alertCode.getCode(), alertSource, instancePk, severity);
        return alertId;
    }

    /**
     * DEFERRED modda acilan alert'ler icin tek ozet bildirim.
     *
     * alertId ve alertKey, gruptaki EN CIDDI alert'e aittir: NotificationService'in
     * spam korumasi, snooze ve bakim penceresi kontrolleri alert_id/alert_key
     * uzerinden calisiyor, dolayisiyla ozetin de gercek bir alert'e baglanmasi
     * gerekiyor.
     */
    public void notifySummary(long alertId, String alertKey, String alertCode, String severity,
                              Long instancePk, String title, String message) {
        fireNotification(alertId, alertKey, alertCode, severity, instancePk, title, message);
    }

    /**
     * Bu kaydin alert'i son N dakika icinde resolve edilmis mi?
     *
     * Kayit bazli cooldown: amaci "flapping"i onlemek, yani bir kayit
     * duzelip hemen bozulduğunda alert'in acilip kapanip acilmasini
     * geciktirmek. Kural seviyesindeki (instance bazli) cooldown bu is icin
     * kullanilamaz — kayit basina alert acilan bir dunyada bir kaydin alert
     * acmasi digerlerini susturur.
     */
    public boolean resolvedWithin(String alertKey, int minutes) {
        if (minutes <= 0) return false;
        try {
            Boolean recent = jdbc.queryForObject(
                "select exists (select 1 from ops.alert" +
                "   where alert_key = ? and status = 'resolved'" +
                "     and resolved_at is not null" +
                "     and resolved_at >= now() - (? * interval '1 minute'))",
                Boolean.class, alertKey, minutes);
            return Boolean.TRUE.equals(recent);
        } catch (Exception e) {
            log.debug("resolvedWithin okunamadi alertKey={}: {}", alertKey, e.getMessage());
            return false; // hata durumunda alert'i engelleme
        }
    }

    /**
     * Bir alert'in su anki severity'si — kapali/olmayan alert icin null.
     *
     * Granular kurallarda kayit basina "onceki severity" gerekiyor, ama
     * control.alert_rule_last_eval instance bazli (PK: rule_id, instance_pk),
     * yani kayit basina durum tutamiyor. Alert'in kendi satirini okumak hem
     * dogru granulerligi veriyor hem de golge durumun surüklenme riskini
     * ortadan kaldiriyor: 2026-08-27'de alert_rule_last_eval "critical" derken
     * ops.alert guncellenmeden 2 saat donmus kalmisti.
     */
    public String openSeverity(String alertKey) {
        try {
            List<String> rows = jdbc.queryForList(
                "select severity from ops.alert where alert_key = ? and status <> 'resolved'",
                String.class, alertKey);
            return rows.isEmpty() ? null : rows.get(0);
        } catch (Exception e) {
            log.debug("openSeverity okunamadi alertKey={}: {}", alertKey, e.getMessage());
            return null;
        }
    }

    /**
     * Verilen onekle baslayan ACIK alert anahtarlari. Granular kurallarda, bu
     * degerlendirmede artik esigi asmayan (dolayisiyla listede yer almayan)
     * kayitlarin alert'lerini bulup kapatmak icin kullanilir — aksi halde bir
     * tablo duzeldiginde alert'i sonsuza kadar acik kalirdi.
     */
    public List<String> openAlertKeysWithPrefix(String prefix) {
        try {
            return jdbc.queryForList(
                "select alert_key from ops.alert" +
                " where alert_key like ? escape '\\' and status <> 'resolved'",
                String.class, prefix.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%");
        } catch (Exception e) {
            log.debug("openAlertKeysWithPrefix okunamadi prefix={}: {}", prefix, e.getMessage());
            return java.util.Collections.emptyList();
        }
    }

    /** Alert'i resolved olarak isaretler. Zaten resolved ise degismez. */
    public void resolve(String alertKey) {
        jdbc.update("""
            update ops.alert
            set status = 'resolved',
                resolved_at = now(),
                last_seen_at = now()
            where alert_key = ?
              and status <> 'resolved'
            """,
            alertKey
        );
        episodes.close(alertKey, AlertEpisodeRepository.CLOSE_RESOLVED);
    }

    /**
     * Alert'i resolved yapar VE gercekten open->resolved gecisi olduysa "risk gecti"
     * bildirimi gonderir. Zaten resolved ise hicbir sey yapmaz (tekrar bildirmez).
     * Title onune "Resolved: " eklenir ki bildirim kanali bunu cozulme olarak gostersin.
     */
    /** resolveDeferred sonucu — bildirim gonderilmedi, cagiran taraf toplayip gonderir. */
    public record ResolvedAlert(long alertId, String severity, Long instancePk) {}

    /**
     * Alert'i resolve eder ama BILDIRIM GONDERMEZ.
     *
     * Granular kurallarda bir degerlendirmede birden fazla kayit ayni anda
     * duzelebilir (orn. senaryo 1c bastirmasi devreye girince bes alert birden
     * kapanir). Her biri icin ayri "Resolved:" mesaji gitmesi, acilis tarafinda
     * cozdugumuz spam'in aynasi olurdu — ustelik daha kotusu: resolve
     * bildirimleri "Resolved:" onekiyle cooldown'i bilerek BYPASS ediyor
     * (bkz. NotificationService.notifyIfNeeded), yani hicbir spam korumasina
     * takilmadan hepsi gider.
     *
     * @return resolve edilen alert bilgisi; zaten resolved ise null
     */
    public ResolvedAlert resolveDeferred(String alertKey) {
        var rows = jdbc.query("""
            update ops.alert
            set status = 'resolved',
                resolved_at = now(),
                last_seen_at = now()
            where alert_key = ?
              and status <> 'resolved'
            returning alert_id, severity, instance_pk
            """,
            (rs, n) -> new ResolvedAlert(rs.getLong("alert_id"), rs.getString("severity"),
                                          (Long) rs.getObject("instance_pk")),
            alertKey
        );
        // Epizot, alarm gercekten open->resolved gectiyse kapanir. rows bos ise
        // alarm zaten resolved'di ve epizot da coktan kapanmis olmali;
        // kosulsuz kapatmak, kapanma damgasini her turda ileri iterdi.
        if (!rows.isEmpty()) {
            episodes.close(alertKey, AlertEpisodeRepository.CLOSE_RESOLVED);
        }
        return rows.isEmpty() ? null : rows.get(0);
    }

    /** Toplu resolve bildirimi — cagiran taraf metni kendisi kurar. */
    public void notifyResolvedSummary(long alertId, String alertKey, String severity,
                                       Long instancePk, String title, String message) {
        // "Resolved:" oneki NotificationService'te cooldown bypass'ini tetikler.
        fireNotification(alertId, alertKey, "adaptive_resolved", severity, instancePk,
            "Resolved: " + title, message);
    }

    public void resolveAndNotify(String alertKey, String title, String message) {
        // Once severity'yi al (bildirim icin) ve resolve et — tek transaction'da
        // RETURNING ile gercekten guncellenen satiri yakala.
        var rows = jdbc.query("""
            update ops.alert
            set status = 'resolved',
                resolved_at = now(),
                last_seen_at = now()
            where alert_key = ?
              and status <> 'resolved'
            returning alert_id, severity, instance_pk
            """,
            (rs, n) -> new Object[]{ rs.getLong("alert_id"), rs.getString("severity"),
                                     (Long) rs.getObject("instance_pk") },
            alertKey
        );
        if (rows.isEmpty()) {
            return; // zaten resolved'di, bildirim yok
        }
        episodes.close(alertKey, AlertEpisodeRepository.CLOSE_RESOLVED);
        long alertId = (Long) rows.get(0)[0];
        String severity = (String) rows.get(0)[1];
        Long instancePk = (Long) rows.get(0)[2];
        // alert_code'u resolve bildiriminde cooldown'i bypass etmek icin "Resolved:" prefix
        // NotificationService systemResolved mantigi title "Resolved:" ile baslayinca devreye girer.
        String resolvedTitle = "Resolved: " + title;
        fireNotification(alertId, alertKey, "adaptive_resolved", severity, instancePk, resolvedTitle, message);
    }

    /**
     * Auto-resolve: transient (dinamik koşullara bağlı) açık alert'ler son tetiklemeden
     * sonra X dakika boyunca yeniden tetiklenmediyse otomatik 'resolved' olur.
     *
     * Bootstrap/auth/extension gibi PERSISTENT (durum düzelene kadar açık kalmalı)
     * alert kodları DAHIL EDİLMEZ.
     *
     * @param staleMinutes son tetiklemeden bu kadar süre geçtiyse kapat (default 120)
     * @return resolved edilen alert sayısı
     */
    public int autoResolveStale(int staleMinutes) {
        // RETURNING ile kapatilan anahtarlar geri alinir: epizodu kapatmak icin
        // hangi alert_key'lerin gercekten degistigini bilmek gerekiyor. Sayiyi
        // bilip anahtarlari bilmemek, epizotlari acik birakirdi.
        java.util.List<String> closedKeys = jdbc.query("""
            update ops.alert
            set status = 'resolved',
                resolved_at = now()
            where status = 'open'
              and last_seen_at < now() - make_interval(mins => ?)
              and alert_code in (
                -- Stale auto-resolve closes transient alerts not refreshed recently.
                -- Burada sadece stats_reset_detected kaldi: event tipi, manuel ACK daha
                -- mantikli ama stale fallback gelecekte istenirse kapatabilir.
                'stats_reset_detected'
              )
            returning alert_key
            """, (rs, n) -> rs.getString("alert_key"), staleMinutes);

        for (String key : closedKeys) {
            // Bu bir cozulme degil, zaman asimi: kosulun duzeldigini kimse
            // dogrulamadi, alarm sadece tazelenmedi. Epizot bunu ayri bir
            // sebeple kapatir ki "iyilesti" ile "haber alinamadi" karismasin.
            episodes.close(key, AlertEpisodeRepository.CLOSE_STALE_TIMEOUT);
        }
        return closedKeys.size();
    }

    /**
     * Acilan/tazelenen bir alarmi epizoda GOLGE olarak yazar.
     *
     * Her zaman ana akisin sonunda, alert satiri yazildiktan sonra cagrilir.
     * episodes.observe() istisna firlatmaz; buradaki cagri alarm uretiminin
     * sonucunu degistiremez.
     *
     * BILINEN SINIR (Adim 1): repository katmani tablo kimligini bilmiyor, bu
     * yuzden dbid/relid/relation_generation null gecilir ve expectsGeneration
     * false. Tablo bazli kurallarin fiziksel kimligi Adim 2'de, evaluator'lar
     * kimligi tasimaya basladiginda dolar. Kimligi UYDURMAK yerine bos
     * birakiliyor: yanlis kimlikle acilan bir epizot iki ayri ihlali
     * birbirine karistirirdi.
     */
    private void shadowObserve(String alertKey, String alertCode, String alertSource,
                                Long instancePk, String severity) {
        episodes.observe(new AlertEpisodeRepository.Observation(
            alertKey, alertCode, alertSource, instancePk,
            null, null, null, false,
            AlertEpisodeRepository.STATE_BREACHING, severity,
            java.time.Instant.now()));
    }

    /**
     * Acik bir alarmin severity'sini gunceller.
     *
     * AlertRuleEvaluator bunu yedi ayri yerde kendi inline SQL'iyle yapiyordu.
     * Bu yazmalar alarm ACMAZ/KAPATMAZ, acilmis satirin severity'sini yamalar —
     * ama epizot acisindan onemliler: severity yukselmesi onayi gecersiz kilan
     * olay ve max_severity'nin kaynagi. Merkezilestirilmeseydi epizodun
     * severity'si kor kalirdi ve KOR OLDUGU BILINEN BIR GOLGE, deploy kapisi
     * olarak kullanilamaz.
     *
     * @param ruleId null degilse ops.alert.rule_id de guncellenir
     */
    public void patchSeverity(String alertKey, String severity, Long ruleId) {
        if (ruleId != null) {
            jdbc.update("update ops.alert set severity = ?, rule_id = ? where alert_key = ?",
                severity, ruleId, alertKey);
        } else {
            jdbc.update("update ops.alert set severity = ? where alert_key = ?",
                severity, alertKey);
        }
        // Epizodun severity'si ana satirla ayni anda ilerlemeli. Yalnizca
        // GUNCELLER, acmaz: yama her zaman acilmis bir alarmin uzerine gelir,
        // burada epizot yoksa uydurma bir alert_code ile satir acmak yanlis
        // olurdu.
        episodes.observeSeverity(alertKey, severity);
    }

    /** Bildirim servisine async olarak iletir. Hata olursa alert akışını bozmaz. */
    private void fireNotification(long alertId, String alertKey, String alertCode, String severity,
                                   Long instancePk, String title, String message) {
        if (notificationService == null) return;
        try {
            notificationService.notifyIfNeeded(alertId, alertKey, alertCode, severity, instancePk, title, message);
        } catch (Exception e) {
            // Bildirim hatası alert akışını kesmemeli
        }
    }
}
