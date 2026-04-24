package com.pgstat.collector.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;

/**
 * pg_stat_statements reset pattern tespiti ve pre-reset snapshot scheduling.
 *
 * Akis:
 * 1. Her reset tespit edildiginde recordReset() cagirilir → history'ye yazar
 * 2. Son 3+ reset'in zamanlari analiz edilir → ayni saat:dakika ise pattern var
 * 3. Pattern varsa pgss_reset_schedule'a yazilir → pre-reset snapshot aktif
 * 4. JobOrchestrator her poll'da checkPreResetSchedule() cagirir
 *    → schedule'daki zamana 30sn kala ekstra statements snapshot tetikler
 * 5. Her yeni reset'te pattern dogrulama yapilir
 *    → 3 ardisik miss → schedule deaktif edilir
 */
@Service
public class PgssResetTracker {

    private static final Logger log = LoggerFactory.getLogger(PgssResetTracker.class);
    private static final int MIN_RESETS_FOR_PATTERN = 3;
    private static final int MAX_MISSED_BEFORE_DEACTIVATE = 3;
    private static final int DEFAULT_TOLERANCE_MINUTES = 5;

    private final JdbcTemplate jdbc;

    public PgssResetTracker(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Reset tespit edildiginde cagirilir.
     * History'ye yazar ve pattern analizi yapar.
     */
    public void recordReset(long instancePk, String newEpochKey, String prevEpochKey,
                            int queryCount, long totalCalls, double totalExecMs,
                            OffsetDateTime lastCollectAt) {
        // Kayip suresi hesapla
        Integer lossSeconds = null;
        if (lastCollectAt != null) {
            lossSeconds = (int) java.time.Duration.between(lastCollectAt, OffsetDateTime.now()).getSeconds();
        }

        // History'ye kaydet
        jdbc.update("""
            insert into control.pgss_reset_history
              (instance_pk, reset_epoch_key, prev_epoch_key,
               pre_reset_query_count, pre_reset_total_calls, pre_reset_total_exec_ms,
               last_collect_before_reset, data_loss_seconds)
            values (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            instancePk, newEpochKey, prevEpochKey,
            queryCount, totalCalls, totalExecMs,
            lastCollectAt, lossSeconds);

        // Pattern analizi
        analyzePattern(instancePk);
    }

    /**
     * Son reset'leri analiz edip pattern tespit eder.
     * 3+ reset ayni saat:dakika (±tolerance) ise schedule olusturur.
     */
    private void analyzePattern(long instancePk) {
        List<Map<String, Object>> resets = jdbc.queryForList("""
            select detected_at
            from control.pgss_reset_history
            where instance_pk = ?
            order by detected_at desc
            limit 10
            """, instancePk);

        if (resets.size() < MIN_RESETS_FOR_PATTERN) {
            log.debug("Yetersiz reset gecmisi instance={}: {} reset", instancePk, resets.size());
            return;
        }

        // Her reset'in UTC saat:dakika'sini al
        int[] hours = new int[resets.size()];
        int[] minutes = new int[resets.size()];
        for (int i = 0; i < resets.size(); i++) {
            OffsetDateTime dt = ((OffsetDateTime) resets.get(i).get("detected_at"))
                .withOffsetSameInstant(ZoneOffset.UTC);
            hours[i] = dt.getHour();
            minutes[i] = dt.getMinute();
        }

        // Son 3 reset'in saat:dakika'si ayni mi? (±tolerance)
        int refHour = hours[0];
        int refMinute = minutes[0];
        int matchCount = 0;

        for (int i = 0; i < Math.min(resets.size(), 7); i++) {
            if (hours[i] == refHour && Math.abs(minutes[i] - refMinute) <= DEFAULT_TOLERANCE_MINUTES) {
                matchCount++;
            }
        }

        if (matchCount >= MIN_RESETS_FOR_PATTERN) {
            // Pattern tespit edildi — schedule olustur veya guncelle
            jdbc.update("""
                insert into control.pgss_reset_schedule
                  (instance_pk, reset_hour, reset_minute, confidence,
                   tolerance_minutes, is_active, last_validated_at, missed_count, updated_at)
                values (?, ?, ?, ?, ?, true, now(), 0, now())
                on conflict (instance_pk) do update set
                  reset_hour = excluded.reset_hour,
                  reset_minute = excluded.reset_minute,
                  confidence = excluded.confidence,
                  is_active = true,
                  last_validated_at = now(),
                  missed_count = 0,
                  updated_at = now()
                """,
                instancePk, refHour, refMinute, matchCount, DEFAULT_TOLERANCE_MINUTES);

            log.info("Reset pattern tespit edildi instance={}: her gun {}:{} UTC (guven={}, tolerans=±{}dk)",
                instancePk, String.format("%02d", refHour), String.format("%02d", refMinute),
                matchCount, DEFAULT_TOLERANCE_MINUTES);
        } else {
            // Pattern yok veya bozuldu — mevcut schedule varsa missed_count artir
            validateExistingSchedule(instancePk);
        }
    }

    /**
     * Mevcut schedule'i dogrular. Pattern'e uymayan reset geldiginde cagirilir.
     * 3 ardisik miss → schedule deaktif.
     */
    private void validateExistingSchedule(long instancePk) {
        jdbc.update("""
            update control.pgss_reset_schedule
            set missed_count = missed_count + 1,
                is_active = case when missed_count + 1 >= ? then false else is_active end,
                updated_at = now()
            where instance_pk = ?
              and is_active = true
            """,
            MAX_MISSED_BEFORE_DEACTIVATE, instancePk);

        // Deaktif edildiyse logla
        List<Map<String, Object>> deactivated = jdbc.queryForList("""
            select reset_hour, reset_minute, missed_count
            from control.pgss_reset_schedule
            where instance_pk = ? and is_active = false and missed_count >= ?
            """, instancePk, MAX_MISSED_BEFORE_DEACTIVATE);

        if (!deactivated.isEmpty()) {
            log.warn("Reset pattern deaktif edildi instance={}: {} ardisik miss",
                instancePk, MAX_MISSED_BEFORE_DEACTIVATE);
        }
    }

    /**
     * JobOrchestrator her poll'da cagirir.
     * Aktif schedule'lari kontrol eder, reset zamanina 30sn kala
     * true doner → ekstra statements snapshot tetiklenmeli.
     *
     * @return pre-reset snapshot alinmasi gereken instance PK'lari
     */
    public List<Long> checkPreResetSchedules() {
        // Simdi UTC saat:dakika
        OffsetDateTime nowUtc = OffsetDateTime.now(ZoneOffset.UTC);
        int nowHour = nowUtc.getHour();
        int nowMinute = nowUtc.getMinute();
        int nowSecond = nowUtc.getSecond();

        // Aktif schedule'lardan, reset zamanina 30sn kala olanlari bul
        // Ornek: reset 03:00, pre_snapshot_offset=30sn → 02:59:30'da tetikle
        return jdbc.queryForList("""
            select instance_pk
            from control.pgss_reset_schedule
            where is_active = true
              and reset_hour = ?
              and reset_minute = ?
              and ? between (60 - pre_snapshot_offset_seconds) and 59
            """,
            Long.class,
            nowHour,
            // Reset dakikasi: eger offset 30sn ise, reset_minute'den 1 onceki dakikada
            // kontrol etmeliyiz. Ornek: reset 03:00 → 02:59:30'da tetikle
            nowMinute + 1 > 59 ? 0 : nowMinute + 1,
            nowSecond);
    }

    /**
     * Daha basit ve guvenilir versiyon:
     * Reset zamanina yakin mi kontrol eder (±pre_snapshot_offset saniye).
     *
     * @return pre-reset snapshot alinmasi gereken instance PK'lari
     */
    public List<Long> findInstancesNeedingPreResetSnapshot() {
        return jdbc.queryForList("""
            select s.instance_pk
            from control.pgss_reset_schedule s
            where s.is_active = true
              and extract(hour from now() at time zone 'UTC') = s.reset_hour
              and extract(minute from now() at time zone 'UTC') = greatest(s.reset_minute - 1, 0)
              and extract(second from now() at time zone 'UTC') >= (60 - s.pre_snapshot_offset_seconds)
              and not exists (
                -- Bu dakika icinde zaten snapshot alinmissa tekrar alma
                select 1 from ops.job_run jr
                where jr.job_type = 'pre_reset_snapshot'
                  and jr.started_at > now() - interval '2 minutes'
              )
            """,
            Long.class);
    }
}
