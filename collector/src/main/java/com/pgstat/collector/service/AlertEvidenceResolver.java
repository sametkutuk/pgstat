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
 * "Alert'i tetikleyen kanit hala gecerli mi?" sorusunu sorar. Cevap hayirsa kapatir.
 * Mevcut autoResolveStale ("son N dk tetiklenmedi -> kapat") yaklasimindan daha
 * hassas: alert tetiklenmesinin nedeni hala mevcut mu degil mi gercek datay ile bakar.
 *
 * Faz 1: high_temp_files + temp-related user_defined_rule
 * Faz 2: idle_in_tx, replication_slot_inactive, high_connection_usage,
 *        replication_lag, stale_data, index_unused
 * Faz 3 (bu commit): long_running_query, lock_contention, high_bloat_ratio,
 *                    index_suspect_missing
 * Kapsam disi: stats_reset_detected (event tipi, manuel ACK)
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

    /** index_unused alert'i daha uzun yasayabilir — 30 gunluk gozlem penceresi. */
    private static final int INDEX_UNUSED_MAX_AGE_HOURS = 24 * 30;

    private final JdbcTemplate jdbc;
    private final AlertRepository alertRepo;
    private final SystemAlertConfigCache configCache;

    public AlertEvidenceResolver(JdbcTemplate jdbc, AlertRepository alertRepo,
                                  SystemAlertConfigCache configCache) {
        this.jdbc = jdbc;
        this.alertRepo = alertRepo;
        this.configCache = configCache;
    }

    /**
     * Tum desteklenen acik alert'leri kontrol et, kanit yoksa kapat.
     *
     * @return resolve edilen alert sayisi
     */
    public int resolveByEvidence() {
        int resolved = 0;
        resolved += safe("temp_alerts", this::resolveTempAlerts);
        resolved += safe("idle_in_tx", this::resolveIdleInTx);
        resolved += safe("slot_inactive", this::resolveReplicationSlotInactive);
        resolved += safe("conn_usage", this::resolveHighConnectionUsage);
        resolved += safe("repl_lag", this::resolveReplicationLag);
        resolved += safe("stale_data", this::resolveStaleData);
        resolved += safe("index_unused", this::resolveIndexUnused);
        resolved += safe("long_running_query", this::resolveLongRunningQuery);
        resolved += safe("lock_contention", this::resolveLockContention);
        resolved += safe("high_bloat_ratio", this::resolveHighBloatRatio);
        resolved += safe("index_suspect_missing", this::resolveIndexSuspectMissing);
        return resolved;
    }

    private int safe(String name, java.util.function.IntSupplier fn) {
        try { return fn.getAsInt(); }
        catch (Exception e) {
            log.warn("Evidence resolver {} hatasi: {}", name, e.getMessage());
            return 0;
        }
    }

    /** Faz 1: high_temp_files + temp user_defined_rule. */
    private int resolveTempAlerts() {
        int resolved = 0;
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

    // =========================================================================
    // Faz 2 — 6 yeni alert kodu icin evidence resolver
    // =========================================================================

    /**
     * idle_in_tx_time_high: details.context.database (datname) icin
     * last_seen_at + 5dk sonrasi idle_pct hala threshold ustunde mi?
     */
    private int resolveIdleInTx() {
        int resolved = 0;
        List<Map<String, Object>> openAlerts = jdbc.queryForList("""
            select alert_id, alert_key, instance_pk, last_seen_at, details_json
            from ops.alert
            where status = 'open'
              and alert_code = 'idle_in_tx_time_high'
              and last_seen_at > now() - make_interval(hours => ?)
            """, MAX_AGE_HOURS);

        for (Map<String, Object> a : openAlerts) {
            if (!ageAtLeast(a, MIN_AGE_MINUTES)) continue;
            long alertId = ((Number) a.get("alert_id")).longValue();
            long instancePk = ((Number) a.get("instance_pk")).longValue();
            Timestamp lastSeen = (Timestamp) a.get("last_seen_at");
            String detailsJson = a.get("details_json") != null ? a.get("details_json").toString() : null;

            String datname = readContextString(detailsJson, "database");
            if (datname == null) continue;  // kanit cikarilamaz

            try {
                Map<String, Object> row = jdbc.queryForMap("""
                    select coalesce(round(100.0 * sum(idle_in_transaction_time_ms_delta)::numeric
                             / nullif(sum(session_time_ms_delta), 0), 1), 0) as idle_pct,
                           coalesce(sum(session_time_ms_delta), 0) as total_session_ms
                    from fact.pg_database_delta
                    where instance_pk = ? and datname = ?
                      and sample_ts > ? + make_interval(mins => ?)
                      and sample_ts <= now()
                    """, instancePk, datname, lastSeen, TOLERANCE_MINUTES);
                long sessionMs = ((Number) row.get("total_session_ms")).longValue();
                if (sessionMs < 60000) continue;  // yetersiz veri, acik tut
                java.math.BigDecimal idlePct = (java.math.BigDecimal) row.get("idle_pct");
                java.math.BigDecimal threshold = configCache.getThreshold(
                    "idle_in_tx_time_high", instancePk, new java.math.BigDecimal("30"));
                if (idlePct.compareTo(threshold) < 0) {
                    alertRepo.resolve((String) a.get("alert_key"));
                    log.info("Evidence resolver: idle_in_tx alert {} kapatildi (idle_pct={} < {})",
                        alertId, idlePct, threshold);
                    resolved++;
                }
            } catch (Exception e) {
                log.debug("idle_in_tx resolver alert={} hatasi: {}", alertId, e.getMessage());
            }
        }
        return resolved;
    }

    /**
     * replication_slot_inactive: slot artik aktif mi, lag esik altinda mi, VEYA slot drop edildi mi?
     * Slot drop -> resolve (Felsefe B: kanit yok = sorun yok)
     */
    private int resolveReplicationSlotInactive() {
        int resolved = 0;
        List<Map<String, Object>> openAlerts = jdbc.queryForList("""
            select alert_id, alert_key, instance_pk, last_seen_at, details_json
            from ops.alert
            where status = 'open'
              and alert_code = 'replication_slot_inactive'
              and last_seen_at > now() - make_interval(hours => ?)
            """, MAX_AGE_HOURS);

        for (Map<String, Object> a : openAlerts) {
            if (!ageAtLeast(a, MIN_AGE_MINUTES)) continue;
            long alertId = ((Number) a.get("alert_id")).longValue();
            long instancePk = ((Number) a.get("instance_pk")).longValue();
            String alertKey = (String) a.get("alert_key");
            String detailsJson = a.get("details_json") != null ? a.get("details_json").toString() : null;

            // Karma lookup: details first, alert_key fallback
            // alert_key format: "actionable:slot_inactive:<instance_pk>:<slot_name>"
            String slotName = readContextString(detailsJson, "slot_name");
            if (slotName == null) {
                String[] parts = alertKey.split(":");
                if (parts.length >= 4) slotName = parts[3];
            }
            if (slotName == null) continue;

            try {
                List<Map<String, Object>> rows = jdbc.queryForList("""
                    select active, slot_lag_bytes
                    from fact.pg_replication_slot_snapshot
                    where instance_pk = ? and slot_name = ?
                    order by sample_ts desc limit 1
                    """, instancePk, slotName);

                boolean shouldResolve = false;
                String reason = null;
                if (rows.isEmpty()) {
                    // Slot drop edildi -> Felsefe B: kapat
                    shouldResolve = true;
                    reason = "slot drop edildi";
                } else {
                    Map<String, Object> last = rows.get(0);
                    Boolean active = (Boolean) last.get("active");
                    long lagBytes = last.get("slot_lag_bytes") != null
                        ? ((Number) last.get("slot_lag_bytes")).longValue() : 0L;
                    java.math.BigDecimal thresholdMb = configCache.getThreshold(
                        "replication_slot_inactive", instancePk, new java.math.BigDecimal("1024"));
                    long thresholdBytes = thresholdMb.longValue() * 1_048_576L;
                    if (Boolean.TRUE.equals(active)) {
                        shouldResolve = true;
                        reason = "slot aktif";
                    } else if (lagBytes < thresholdBytes) {
                        shouldResolve = true;
                        reason = "lag (" + lagBytes + ") < threshold (" + thresholdBytes + ")";
                    }
                }
                if (shouldResolve) {
                    alertRepo.resolve(alertKey);
                    log.info("Evidence resolver: slot_inactive alert {} kapatildi ({})", alertId, reason);
                    resolved++;
                }
            } catch (Exception e) {
                log.debug("slot_inactive resolver alert={} hatasi: {}", alertId, e.getMessage());
            }
        }
        return resolved;
    }

    /**
     * high_connection_usage: son 10dk snapshot'ta numbackends/max_connections esik altinda mi?
     */
    private int resolveHighConnectionUsage() {
        int resolved = 0;
        List<Map<String, Object>> openAlerts = jdbc.queryForList("""
            select alert_id, alert_key, instance_pk, last_seen_at
            from ops.alert
            where status = 'open'
              and alert_code = 'high_connection_usage'
              and last_seen_at > now() - make_interval(hours => ?)
            """, MAX_AGE_HOURS);

        for (Map<String, Object> a : openAlerts) {
            if (!ageAtLeast(a, MIN_AGE_MINUTES)) continue;
            long alertId = ((Number) a.get("alert_id")).longValue();
            long instancePk = ((Number) a.get("instance_pk")).longValue();

            try {
                Map<String, Object> row = jdbc.queryForMap("""
                    with latest as (
                      select max(sample_ts) as ts
                      from fact.pg_database_delta
                      where instance_pk = ? and sample_ts > now() - interval '10 minutes'
                    ),
                    conn as (
                      select coalesce(sum(d.numbackends), 0) as total
                      from fact.pg_database_delta d, latest l
                      where d.instance_pk = ? and d.sample_ts = l.ts
                    ),
                    mc as (
                      select nullif(setting_value, '')::integer as max_conn
                      from fact.pg_settings_snapshot
                      where instance_pk = ? and setting_name = 'max_connections'
                      order by snapshot_ts desc limit 1
                    )
                    select (select ts from latest) as latest_ts,
                           round(100.0 * (select total from conn) / nullif((select max_conn from mc), 0), 1) as usage_pct
                    """, instancePk, instancePk, instancePk);
                if (row.get("latest_ts") == null) continue;  // 10dk'da snapshot yok, stale_data alarm versin
                java.math.BigDecimal usagePct = (java.math.BigDecimal) row.get("usage_pct");
                if (usagePct == null) continue;  // max_conn bilinmiyor
                java.math.BigDecimal threshold = configCache.getThreshold(
                    "high_connection_usage", instancePk, new java.math.BigDecimal("80"));
                if (usagePct.compareTo(threshold) < 0) {
                    alertRepo.resolve((String) a.get("alert_key"));
                    log.info("Evidence resolver: high_connection_usage alert {} kapatildi (usage_pct={} < {})",
                        alertId, usagePct, threshold);
                    resolved++;
                }
            } catch (Exception e) {
                log.debug("high_connection_usage resolver alert={} hatasi: {}", alertId, e.getMessage());
            }
        }
        return resolved;
    }

    /**
     * replication_lag: son 10dk snapshot'ta en kotu replay_lag_bytes esik altinda mi?
     * Snapshot satiri yoksa (standby disconnect) acik tut — Felsefe A.
     */
    private int resolveReplicationLag() {
        int resolved = 0;
        List<Map<String, Object>> openAlerts = jdbc.queryForList("""
            select alert_id, alert_key, instance_pk, last_seen_at
            from ops.alert
            where status = 'open'
              and alert_code = 'replication_lag'
              and last_seen_at > now() - make_interval(hours => ?)
            """, MAX_AGE_HOURS);

        for (Map<String, Object> a : openAlerts) {
            if (!ageAtLeast(a, MIN_AGE_MINUTES)) continue;
            long alertId = ((Number) a.get("alert_id")).longValue();
            long instancePk = ((Number) a.get("instance_pk")).longValue();

            try {
                Map<String, Object> row = jdbc.queryForMap("""
                    with latest as (
                      select max(snapshot_ts) as ts
                      from fact.pg_replication_snapshot
                      where instance_pk = ? and snapshot_ts > now() - interval '10 minutes'
                    )
                    select (select ts from latest) as latest_ts,
                           coalesce((
                             select max(coalesce(replay_lag_bytes, 0))
                             from fact.pg_replication_snapshot s, latest l
                             where s.instance_pk = ? and s.snapshot_ts = l.ts
                           ), 0) as worst_lag
                    """, instancePk, instancePk);
                if (row.get("latest_ts") == null) continue;  // standby yok -> Felsefe A, acik tut
                long worstLag = ((Number) row.get("worst_lag")).longValue();
                java.math.BigDecimal thresholdMb = configCache.getThreshold(
                    "replication_lag", instancePk, new java.math.BigDecimal("50"));
                long thresholdBytes = thresholdMb.longValue() * 1_048_576L;
                if (worstLag < thresholdBytes) {
                    alertRepo.resolve((String) a.get("alert_key"));
                    log.info("Evidence resolver: replication_lag alert {} kapatildi (lag={} < {})",
                        alertId, worstLag, thresholdBytes);
                    resolved++;
                }
            } catch (Exception e) {
                log.debug("replication_lag resolver alert={} hatasi: {}", alertId, e.getMessage());
            }
        }
        return resolved;
    }

    /**
     * stale_data: instance_state.last_cluster_collect_at tazelendi mi?
     * Threshold yerine system_alert_config.window_minutes okunur (V062 ile geldi).
     */
    private int resolveStaleData() {
        int resolved = 0;
        List<Map<String, Object>> openAlerts = jdbc.queryForList("""
            select alert_id, alert_key, instance_pk, last_seen_at
            from ops.alert
            where status = 'open'
              and alert_code = 'stale_data'
              and last_seen_at > now() - make_interval(hours => ?)
            """, MAX_AGE_HOURS);

        for (Map<String, Object> a : openAlerts) {
            if (!ageAtLeast(a, MIN_AGE_MINUTES)) continue;
            long alertId = ((Number) a.get("alert_id")).longValue();
            long instancePk = ((Number) a.get("instance_pk")).longValue();

            try {
                Map<String, Object> row = jdbc.queryForMap("""
                    select extract(epoch from (now() - last_cluster_collect_at))/60 as stale_min,
                           last_cluster_collect_at
                    from control.instance_state
                    where instance_pk = ?
                    """, instancePk);
                if (row.get("last_cluster_collect_at") == null) continue;  // bilinmiyor
                java.math.BigDecimal staleMin = (java.math.BigDecimal) row.get("stale_min");
                int windowMin = configCache.getWindowMinutes("stale_data", instancePk, 10);
                if (staleMin.compareTo(new java.math.BigDecimal(windowMin)) < 0) {
                    alertRepo.resolve((String) a.get("alert_key"));
                    log.info("Evidence resolver: stale_data alert {} kapatildi (stale={} dk < {})",
                        alertId, staleMin, windowMin);
                    resolved++;
                }
            } catch (Exception e) {
                log.debug("stale_data resolver alert={} hatasi: {}", alertId, e.getMessage());
            }
        }
        return resolved;
    }

    /**
     * index_unused: alert sonrasi idx_scan_delta > 0 ise resolve.
     * details_json'dan schemaname/indexrelname okur, yoksa eski format 'index' alanini parse eder.
     * MAX_AGE_HOURS = 30 gun (gozlem penceresi).
     */
    private int resolveIndexUnused() {
        int resolved = 0;
        List<Map<String, Object>> openAlerts = jdbc.queryForList("""
            select alert_id, alert_key, instance_pk, last_seen_at, details_json
            from ops.alert
            where status = 'open'
              and alert_code = 'index_unused'
              and last_seen_at > now() - make_interval(hours => ?)
            """, INDEX_UNUSED_MAX_AGE_HOURS);

        for (Map<String, Object> a : openAlerts) {
            if (!ageAtLeast(a, MIN_AGE_MINUTES)) continue;
            long alertId = ((Number) a.get("alert_id")).longValue();
            long instancePk = ((Number) a.get("instance_pk")).longValue();
            Timestamp lastSeen = (Timestamp) a.get("last_seen_at");
            String detailsJson = a.get("details_json") != null ? a.get("details_json").toString() : null;

            String schemaname = readContextString(detailsJson, "schemaname");
            String indexrelname = readContextString(detailsJson, "indexrelname");
            // Eski format fallback: context.index = "schema.indexname"
            if (schemaname == null || indexrelname == null) {
                String idx = readContextString(detailsJson, "index");
                if (idx != null && idx.contains(".")) {
                    int dot = idx.indexOf('.');
                    schemaname = idx.substring(0, dot);
                    indexrelname = idx.substring(dot + 1);
                }
            }
            if (schemaname == null || indexrelname == null) continue;

            try {
                Long scans = jdbc.queryForObject("""
                    select coalesce(sum(idx_scan_delta), 0)::bigint
                    from fact.pg_index_stat_delta
                    where instance_pk = ?
                      and schemaname = ? and indexrelname = ?
                      and sample_ts > ? + make_interval(mins => ?)
                      and sample_ts <= now()
                    """, Long.class, instancePk, schemaname, indexrelname, lastSeen, TOLERANCE_MINUTES);
                if (scans != null && scans > 0) {
                    alertRepo.resolve((String) a.get("alert_key"));
                    log.info("Evidence resolver: index_unused alert {} kapatildi — index {}.{} kullanildi ({} tarama)",
                        alertId, schemaname, indexrelname, scans);
                    resolved++;
                }
            } catch (Exception e) {
                log.debug("index_unused resolver alert={} hatasi: {}", alertId, e.getMessage());
            }
        }
        return resolved;
    }

    // =========================================================================
    // Faz 3 — 4 yeni alert kodu icin evidence resolver
    // =========================================================================

    /**
     * long_running_query: ayni pid + query_start hala 'active' ve duration > threshold mi?
     * Pid kaybolduysa, state degistiyse, query_start degistiyse, duration eski_ig_ise -> resolve.
     */
    private int resolveLongRunningQuery() {
        int resolved = 0;
        List<Map<String, Object>> openAlerts = jdbc.queryForList("""
            select alert_id, alert_key, instance_pk, last_seen_at, details_json
            from ops.alert
            where status = 'open'
              and alert_code = 'long_running_query'
              and last_seen_at > now() - make_interval(hours => ?)
            """, MAX_AGE_HOURS);

        for (Map<String, Object> a : openAlerts) {
            if (!ageAtLeast(a, MIN_AGE_MINUTES)) continue;
            long alertId = ((Number) a.get("alert_id")).longValue();
            long instancePk = ((Number) a.get("instance_pk")).longValue();
            String alertKey = (String) a.get("alert_key");
            String detailsJson = a.get("details_json") != null ? a.get("details_json").toString() : null;

            // pid: details.context.pid, yoksa alert_key parse
            // alert_key format: "actionable:long_running_query:<instance_pk>:<pid>"
            String pidStr = readContextString(detailsJson, "pid");
            if (pidStr == null) {
                String[] parts = alertKey.split(":");
                if (parts.length >= 4) pidStr = parts[3];
            }
            if (pidStr == null) continue;
            Integer pid;
            try { pid = Integer.parseInt(pidStr); } catch (Exception e) { continue; }

            // query_start: yeni format'tan oku (eski alert'lerde olmayabilir, fallback yok)
            String queryStartStr = readContextString(detailsJson, "query_start");

            try {
                Map<String, Object> row = jdbc.queryForMap("""
                    with latest as (
                      select max(snapshot_ts) as ts
                      from fact.pg_activity_snapshot
                      where instance_pk = ?
                    )
                    select a.pid, a.state, a.query_start,
                           extract(epoch from (l.ts - a.query_start))::bigint as duration_sec
                    from fact.pg_activity_snapshot a, latest l
                    where a.instance_pk = ? and a.snapshot_ts = l.ts and a.pid = ?
                    union all
                    select null, null, null, null
                    order by pid nulls last
                    limit 1
                    """, instancePk, instancePk, pid);

                boolean shouldResolve = false;
                String reason = null;
                if (row.get("pid") == null) {
                    shouldResolve = true; reason = "pid kayboldu";
                } else {
                    String state = (String) row.get("state");
                    if (!"active".equals(state)) {
                        shouldResolve = true; reason = "state=" + state;
                    } else if (queryStartStr != null) {
                        // query_start kontrolu: degisti ise baska sorguya atandi
                        String currentQs = String.valueOf(row.get("query_start"));
                        if (!queryStartStr.equals(currentQs)
                                && !currentQs.startsWith(queryStartStr.substring(0, Math.min(queryStartStr.length(), 19)))) {
                            shouldResolve = true; reason = "query_start degisti";
                        }
                    }
                    if (!shouldResolve) {
                        long durationSec = ((Number) row.get("duration_sec")).longValue();
                        java.math.BigDecimal threshold = configCache.getThreshold(
                            "long_running_query", instancePk, new java.math.BigDecimal("300"));
                        if (durationSec < threshold.longValue()) {
                            shouldResolve = true;
                            reason = "duration (" + durationSec + ") < threshold (" + threshold + ")";
                        }
                    }
                }
                if (shouldResolve) {
                    alertRepo.resolve(alertKey);
                    log.info("Evidence resolver: long_running_query alert {} kapatildi ({})", alertId, reason);
                    resolved++;
                }
            } catch (Exception e) {
                log.debug("long_running_query resolver alert={} hatasi: {}", alertId, e.getMessage());
            }
        }
        return resolved;
    }

    /**
     * lock_contention: son 5dk snapshot'ta hala uzun bekleyen lock var mi?
     * Alert anahtarı pid-bagimsiz (instance bazinda) — yani "instance'ta lock contention var" diyor.
     */
    private int resolveLockContention() {
        int resolved = 0;
        List<Map<String, Object>> openAlerts = jdbc.queryForList("""
            select alert_id, alert_key, instance_pk, last_seen_at
            from ops.alert
            where status = 'open'
              and alert_code = 'lock_contention'
              and last_seen_at > now() - make_interval(hours => ?)
            """, MAX_AGE_HOURS);

        for (Map<String, Object> a : openAlerts) {
            if (!ageAtLeast(a, MIN_AGE_MINUTES)) continue;
            long alertId = ((Number) a.get("alert_id")).longValue();
            long instancePk = ((Number) a.get("instance_pk")).longValue();

            try {
                java.math.BigDecimal thresholdSec = configCache.getThreshold(
                    "lock_contention", instancePk, new java.math.BigDecimal("300"));
                List<Map<String, Object>> contention = jdbc.queryForList("""
                    with latest as (
                      select max(snapshot_ts) as ts
                      from fact.pg_lock_snapshot
                      where instance_pk = ? and snapshot_ts > now() - interval '5 minutes'
                    )
                    select 1 as has_contention
                    from fact.pg_lock_snapshot s, latest l
                    where s.instance_pk = ?
                      and s.snapshot_ts = l.ts
                      and s.waitstart is not null
                      and (now() - s.waitstart) > make_interval(secs => ?)
                    limit 1
                    """, instancePk, instancePk, thresholdSec.intValue());
                // Son 5dk snapshot yoksa latest.ts null -> join sonuc bos -> contention bos.
                // Bu durumda Felsefe A (acik tut) yerine Felsefe B uygulamak yanlis olur:
                // "snapshot yok" => "lock yok" demeyiz. Atla.
                Long latestTs = jdbc.queryForObject("""
                    select extract(epoch from max(snapshot_ts))::bigint
                    from fact.pg_lock_snapshot
                    where instance_pk = ? and snapshot_ts > now() - interval '5 minutes'
                    """, Long.class, instancePk);
                if (latestTs == null) continue;  // snapshot yok, acik tut
                if (contention.isEmpty()) {
                    alertRepo.resolve((String) a.get("alert_key"));
                    log.info("Evidence resolver: lock_contention alert {} kapatildi — son 5dk'da bekleyen lock yok",
                        alertId);
                    resolved++;
                }
            } catch (Exception e) {
                log.debug("lock_contention resolver alert={} hatasi: {}", alertId, e.getMessage());
            }
        }
        return resolved;
    }

    /**
     * high_bloat_ratio: son snapshot'ta dead_pct < threshold mi?
     * Eski format alert'lerde context.relation = "schema.relname" parse fallback.
     */
    private int resolveHighBloatRatio() {
        int resolved = 0;
        List<Map<String, Object>> openAlerts = jdbc.queryForList("""
            select alert_id, alert_key, instance_pk, last_seen_at, details_json
            from ops.alert
            where status = 'open'
              and alert_code = 'high_bloat_ratio'
              and last_seen_at > now() - make_interval(hours => ?)
            """, MAX_AGE_HOURS);

        for (Map<String, Object> a : openAlerts) {
            if (!ageAtLeast(a, MIN_AGE_MINUTES)) continue;
            long alertId = ((Number) a.get("alert_id")).longValue();
            long instancePk = ((Number) a.get("instance_pk")).longValue();
            String detailsJson = a.get("details_json") != null ? a.get("details_json").toString() : null;

            String schemaname = readContextString(detailsJson, "schemaname");
            String relname = readContextString(detailsJson, "relname");
            if (schemaname == null || relname == null) {
                String rel = readContextString(detailsJson, "relation");
                if (rel != null && rel.contains(".")) {
                    int dot = rel.indexOf('.');
                    schemaname = rel.substring(0, dot);
                    relname = rel.substring(dot + 1);
                }
            }
            if (schemaname == null || relname == null) continue;

            try {
                java.math.BigDecimal deadPct = jdbc.queryForObject("""
                    select round(100.0 * t.n_dead_tup_estimate::numeric
                           / nullif(t.n_live_tup_estimate + t.n_dead_tup_estimate, 0), 1)
                    from fact.pg_table_stat_delta t
                    where t.instance_pk = ?
                      and t.schemaname = ? and t.relname = ?
                      and t.sample_ts = (
                        select max(sample_ts) from fact.pg_table_stat_delta
                        where instance_pk = ? and schemaname = ? and relname = ?
                      )
                    """, java.math.BigDecimal.class,
                    instancePk, schemaname, relname, instancePk, schemaname, relname);
                if (deadPct == null) continue;  // veri yok, acik tut
                java.math.BigDecimal threshold = configCache.getThreshold(
                    "high_bloat_ratio", instancePk, new java.math.BigDecimal("20"));
                if (deadPct.compareTo(threshold) < 0) {
                    alertRepo.resolve((String) a.get("alert_key"));
                    log.info("Evidence resolver: high_bloat_ratio alert {} kapatildi (dead_pct={} < {})",
                        alertId, deadPct, threshold);
                    resolved++;
                }
            } catch (Exception e) {
                log.debug("high_bloat_ratio resolver alert={} hatasi: {}", alertId, e.getMessage());
            }
        }
        return resolved;
    }

    /**
     * index_suspect_missing: son 24h ratio < threshold mi VEYA seq_tup_read cok dustu mu?
     * Eski format alert'lerde context.table = "schema.relname" parse fallback.
     */
    private int resolveIndexSuspectMissing() {
        int resolved = 0;
        List<Map<String, Object>> openAlerts = jdbc.queryForList("""
            select alert_id, alert_key, instance_pk, last_seen_at, details_json
            from ops.alert
            where status = 'open'
              and alert_code = 'index_suspect_missing'
              and last_seen_at > now() - make_interval(hours => ?)
            """, MAX_AGE_HOURS);

        for (Map<String, Object> a : openAlerts) {
            if (!ageAtLeast(a, MIN_AGE_MINUTES)) continue;
            long alertId = ((Number) a.get("alert_id")).longValue();
            long instancePk = ((Number) a.get("instance_pk")).longValue();
            String detailsJson = a.get("details_json") != null ? a.get("details_json").toString() : null;

            String schemaname = readContextString(detailsJson, "schemaname");
            String relname = readContextString(detailsJson, "relname");
            if (schemaname == null || relname == null) {
                String tbl = readContextString(detailsJson, "table");
                if (tbl != null && tbl.contains(".")) {
                    int dot = tbl.indexOf('.');
                    schemaname = tbl.substring(0, dot);
                    relname = tbl.substring(dot + 1);
                }
            }
            if (schemaname == null || relname == null) continue;

            try {
                Map<String, Object> row = jdbc.queryForMap("""
                    select coalesce(sum(seq_scan_delta), 0) as seq_scans,
                           coalesce(sum(idx_scan_delta), 0) as idx_scans,
                           coalesce(sum(seq_tup_read_delta), 0) as seq_tup_read,
                           round(case when sum(idx_scan_delta) > 0
                                      then sum(seq_scan_delta)::numeric / sum(idx_scan_delta)
                                      else 9999 end, 1) as ratio
                    from fact.pg_table_stat_delta
                    where instance_pk = ?
                      and schemaname = ? and relname = ?
                      and sample_ts > now() - interval '24 hours'
                    """, instancePk, schemaname, relname);
                long seqTupRead = ((Number) row.get("seq_tup_read")).longValue();
                java.math.BigDecimal ratio = (java.math.BigDecimal) row.get("ratio");
                if (ratio == null) continue;  // veri yok, acik tut
                java.math.BigDecimal threshold = configCache.getThreshold(
                    "index_suspect_missing", instancePk, new java.math.BigDecimal("100"));

                boolean shouldResolve = false;
                String reason = null;
                if (ratio.compareTo(threshold) < 0) {
                    shouldResolve = true;
                    reason = "ratio (" + ratio + ") < threshold (" + threshold + ")";
                } else if (seqTupRead < 100000) {
                    shouldResolve = true;
                    reason = "seq_tup_read (" + seqTupRead + ") < 100K";
                }
                if (shouldResolve) {
                    alertRepo.resolve((String) a.get("alert_key"));
                    log.info("Evidence resolver: index_suspect_missing alert {} kapatildi ({})",
                        alertId, reason);
                    resolved++;
                }
            } catch (Exception e) {
                log.debug("index_suspect_missing resolver alert={} hatasi: {}", alertId, e.getMessage());
            }
        }
        return resolved;
    }

    // =========================================================================
    // Yardimcilar
    // =========================================================================

    /** Alert yas kapisi: en az minMinutes ge�cmis mi? */
    private boolean ageAtLeast(Map<String, Object> a, int minMinutes) {
        Timestamp ts = (Timestamp) a.get("last_seen_at");
        if (ts == null) return false;
        long ageMin = java.time.Duration.between(
            ts.toInstant(), java.time.Instant.now()).toMinutes();
        return ageMin >= minMinutes;
    }

    /** details_json.context.<key> string degerini cikar. */
    private String readContextString(String detailsJson, String key) {
        if (detailsJson == null || detailsJson.isBlank() || detailsJson.equals("null")) return null;
        try {
            return jdbc.queryForObject(
                "select ?::jsonb -> 'context' ->> ?",
                String.class, detailsJson, key);
        } catch (Exception ignore) {
            return null;
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
