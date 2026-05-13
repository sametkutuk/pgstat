package com.pgstat.collector.service;

import com.pgstat.collector.repository.AlertRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.sql.Timestamp;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Kanit-bazli auto-resolve servisi.
 *
 * Mevcut autoResolveStale "son N dakikadir tetiklenmedi -> kapat" mantigini
 * kullanir. Bu yontem yeterince hassas degil: alert tetiklenmesinin nedeni
 * olan sorgu artik yazmiyor olabilir ama autoResolveStale buna bakmadan
 * son tetiklenme zamanina gore karar verir.
 *
 * Yeni mantik (sadece temp_files alert'leri icin — Faz 1):
 *   1. Acik alert icin details_json.records[]'tan queryid + dbid + userid cikar
 *   2. dim.statement_series ile statement_series_id lookup
 *   3. fact.pgss_delta'da alert.last_seen_at + 5dk sonrasi temp_blks_written_delta
 *      var mi? (yani alert tetiklendikten sonra o sorgu hala temp yaziyor mu?)
 *   4. Toplam temp == 0 ise -> kapat
 *   5. > 0 ise -> acik kalsin
 *
 * Kapsam (Faz 1):
 *   - alert_code = 'high_temp_files' (actionable)
 *   - alert_code = 'user_defined_rule' AND rule.metric_name in (temp_files, temp_bytes,
 *     temp_blks_written)
 *
 * Diger alert kodlari icin autoResolveStale fallback olarak calismaya devam eder.
 */
@Service
public class AlertEvidenceResolver {

    private static final Logger log = LoggerFactory.getLogger(AlertEvidenceResolver.class);

    /** Alert tetiklenmesinden bu kadar dakika sonra kanit aramaya basla. */
    private static final int TOLERANCE_MINUTES = 5;

    /** En az bu kadar zaman gectikten sonra resolve kararina var (alert cok yeniyse atla). */
    private static final int MIN_AGE_MINUTES = 10;

    /** Bu yastan eski alert'leri evidence resolver atlasin (stale fallback temizler). */
    private static final int MAX_AGE_HOURS = 24;

    private final JdbcTemplate jdbc;
    private final AlertRepository alertRepo;

    public AlertEvidenceResolver(JdbcTemplate jdbc, AlertRepository alertRepo) {
        this.jdbc = jdbc;
        this.alertRepo = alertRepo;
    }

    /**
     * Tum desteklenen acik alert'leri kontrol et, kanit yoksa kapat.
     *
     * @return resolve edilen alert sayisi
     */
    public int resolveByEvidence() {
        int resolved = 0;
        try {
            List<Map<String, Object>> openAlerts = jdbc.queryForList("""
                select a.alert_id, a.alert_key, a.alert_code, a.instance_pk,
                       a.last_seen_at, a.details_json, ar.metric_name
                from ops.alert a
                left join control.alert_rule ar on ar.rule_id = a.rule_id
                where a.status = 'open'
                  and (
                    a.alert_code = 'high_temp_files'
                    or (a.alert_code = 'user_defined_rule'
                        and ar.metric_name in ('temp_files', 'temp_bytes', 'temp_blks_written'))
                  )
                  and a.last_seen_at > now() - make_interval(hours => ?)
                """, MAX_AGE_HOURS);

            for (Map<String, Object> a : openAlerts) {
                try {
                    if (checkAndResolveTemp(a)) resolved++;
                } catch (Exception e) {
                    log.debug("Evidence resolver alert={} hatasi: {}",
                        a.get("alert_id"), e.getMessage());
                }
            }
        } catch (Exception e) {
            log.warn("Evidence resolver genel hata: {}", e.getMessage());
        }
        return resolved;
    }

    /**
     * Temp-ile-ilgili tek bir alert icin kanit kontrolu yapar, gerekirse resolve eder.
     *
     * @return true = resolve edildi
     */
    private boolean checkAndResolveTemp(Map<String, Object> a) {
        long alertId = ((Number) a.get("alert_id")).longValue();
        String alertKey = (String) a.get("alert_key");
        long instancePk = ((Number) a.get("instance_pk")).longValue();
        Timestamp lastSeenTs = (Timestamp) a.get("last_seen_at");
        if (lastSeenTs == null) return false;
        OffsetDateTime lastSeen = lastSeenTs.toInstant().atOffset(OffsetDateTime.now().getOffset());

        // 1) Alert cok yeni mi? Tolerance + min age tamamlanmamissa atla
        long ageMinutes = java.time.Duration.between(lastSeen, OffsetDateTime.now()).toMinutes();
        if (ageMinutes < MIN_AGE_MINUTES) return false;

        // 2) statement_series_id'leri cikar.
        // Iki yol: (a) records icinde direkt yaziliysa kullan,
        //          (b) yoksa queryid+dbid+userid ile dim.statement_series'tan lookup.
        // Eski format alert'lerde queryid de yoksa kanit cikarilamaz -> acik tut.
        String detailsJson = a.get("details_json") != null ? a.get("details_json").toString() : null;
        if (detailsJson == null || detailsJson.isBlank() || detailsJson.equals("null")) return false;

        List<Long> seriesIds = extractSeriesIdsFromRecords(detailsJson);
        if (seriesIds.isEmpty()) {
            // statement_series_id yok -> queryid+dbid+userid lookup'una dus
            List<long[]> queryKeys = extractQueryKeys(detailsJson);
            if (queryKeys.isEmpty()) return false;  // queryid bile yok, acik tut
            for (long[] k : queryKeys) {
                try {
                    List<Long> ids = jdbc.queryForList("""
                        select statement_series_id from dim.statement_series
                        where instance_pk = ? and queryid = ? and dbid = ? and userid = ?
                        """, Long.class, instancePk, k[0], k[1], k[2]);
                    seriesIds.addAll(ids);
                } catch (Exception ignore) {}
            }
            if (seriesIds.isEmpty()) return false;  // series bulunamadi, acik tut
        }

        // 4) Kanit sorgulama: last_seen_at + tolerance sonrasi temp_blks_written_delta toplam
        Long totalTempBlks;
        try {
            String placeholders = String.join(",", seriesIds.stream().map(s -> "?").toList());
            String sql = "select coalesce(sum(temp_blks_written_delta), 0)::bigint "
                + "from fact.pgss_delta "
                + "where instance_pk = ? "
                + "  and statement_series_id in (" + placeholders + ") "
                + "  and sample_ts > ? + make_interval(mins => ?) "
                + "  and sample_ts <= now()";
            Object[] args = new Object[seriesIds.size() + 3];
            args[0] = instancePk;
            for (int i = 0; i < seriesIds.size(); i++) args[i + 1] = seriesIds.get(i);
            args[seriesIds.size() + 1] = lastSeenTs;
            args[seriesIds.size() + 2] = TOLERANCE_MINUTES;
            totalTempBlks = jdbc.queryForObject(sql, Long.class, args);
        } catch (Exception e) {
            log.debug("Evidence sorgu hatasi alert={}: {}", alertId, e.getMessage());
            return false;
        }

        long totalBytes = (totalTempBlks != null ? totalTempBlks : 0L) * 8192L;

        // 5) Karar
        if (totalBytes == 0L) {
            // Kanit yok -> kapat
            alertRepo.resolve(alertKey);
            log.info("Evidence resolver: alert {} ({}) kapatildi — last_seen_at + {}dk sonra temp yok",
                alertId, alertKey, TOLERANCE_MINUTES);
            return true;
        } else {
            // Hala temp yaziliyor -> acik kalsin
            log.debug("Evidence resolver: alert {} acik — son donemde {} byte temp",
                alertId, totalBytes);
            return false;
        }
    }

    /**
     * details_json.records[] icinde direkt yazili statement_series_id'leri cikar
     * (actionable:high_temp_files yeni format icin). Yoksa bos liste doner.
     */
    private List<Long> extractSeriesIdsFromRecords(String detailsJson) {
        List<Long> ids = new ArrayList<>();
        try {
            List<Map<String, Object>> rows = jdbc.queryForList("""
                select (rec ->> 'statement_series_id')::bigint as ssid
                from jsonb_array_elements(?::jsonb -> 'records') rec
                where rec ? 'statement_series_id'
                  and (rec ->> 'statement_series_id') ~ '^-?[0-9]+$'
                """, detailsJson);
            for (Map<String, Object> r : rows) {
                Object v = r.get("ssid");
                if (v != null) ids.add(((Number) v).longValue());
            }
        } catch (Exception ignore) {}
        return ids;
    }

    /**
     * details_json'dan records[] icindeki (queryid, dbid, userid) ucluleri cikar.
     *
     * Jackson siniflari collector classpath'inde olmadigi icin DB tarafinda
     * jsonb_array_elements ile cikariyoruz — daha sade ve performans icin yeterli.
     */
    private List<long[]> extractQueryKeys(String detailsJson) {
        List<long[]> keys = new ArrayList<>();
        try {
            List<Map<String, Object>> rows = jdbc.queryForList("""
                select (rec ->> 'queryid')::bigint as qid,
                       (rec ->> 'dbid')::bigint    as did,
                       (rec ->> 'userid')::bigint  as uid
                from jsonb_array_elements(?::jsonb -> 'records') rec
                where rec ? 'queryid' and rec ? 'dbid' and rec ? 'userid'
                """, detailsJson);
            for (Map<String, Object> r : rows) {
                Object qid = r.get("qid"), did = r.get("did"), uid = r.get("uid");
                if (qid == null || did == null || uid == null) continue;
                keys.add(new long[]{
                    ((Number) qid).longValue(),
                    ((Number) did).longValue(),
                    ((Number) uid).longValue()
                });
            }
        } catch (Exception ignore) {}
        return keys;
    }
}
