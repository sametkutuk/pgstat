package com.pgstat.collector.service;

import com.pgstat.collector.model.AlertCode;
import com.pgstat.collector.repository.AlertRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Aksiyon-odakli built-in alert evaluator.
 * UTC 04:00'te JobOrchestrator tarafindan gunde 1 kez tetiklenir.
 * Gece snapshot (03:00) + runtime fact tablolarindan veri okur.
 *
 * Alert'ler:
 * 1. INDEX_SUSPECT_MISSING — seq_scan/idx_scan > 100, tablo > 10MB
 * 2. INDEX_UNUSED — 30g idx_scan=0
 * 3. HIGH_TEMP_FILES — temp_files > 100/saat
 * 4. IDLE_IN_TX_TIME_HIGH — idle_in_tx / session > 30% (PG14+)
 * 5. REPLICATION_SLOT_INACTIVE — 1h inactive, lag > 1GB
 *
 * Her alert somut SQL aksiyon onerisi icerir.
 */
@Service
public class ActionableAlertEvaluator {

    private static final Logger log = LoggerFactory.getLogger(ActionableAlertEvaluator.class);

    private final JdbcTemplate jdbc;
    private final AlertRepository alertRepo;
    private final AlertMessageRenderer renderer;
    private final SystemAlertConfigCache configCache;
    private static final long DAILY_TEMP_SQL_MIN_BYTES = 100L * 1024L * 1024L;
    private static final long DAILY_TEMP_SQL_MIN_MB = DAILY_TEMP_SQL_MIN_BYTES / 1024L / 1024L;

    public ActionableAlertEvaluator(JdbcTemplate jdbc, AlertRepository alertRepo,
                                     AlertMessageRenderer renderer,
                                     SystemAlertConfigCache configCache) {
        this.jdbc = jdbc;
        this.alertRepo = alertRepo;
        this.renderer = renderer;
        this.configCache = configCache;
    }

    /** Tum gunluk alert'leri degerlendir. Hata olursa diger alert'lere devam et. */
    public void evaluateAll() {
        log.info("Aksiyon-odakli alert degerlendirmesi basliyor (gunluk)...");
        int total = 0;
        total += safeEval("INDEX_SUSPECT_MISSING", this::checkIndexSuspectMissing);
        total += safeEval("INDEX_UNUSED", this::checkIndexUnused);
        total += safeEval("INDEX_INVALID", this::checkIndexInvalid);
        total += safeEval("HIGH_TEMP_FILES_DAILY", this::checkHighTempFilesDaily);
        total += safeEval("HIGH_TEMP_SQLS_DAILY", this::checkHighTempSqlsDaily);
        total += safeEval("HIGH_BLOAT_RATIO", this::checkHighBloatRatio);
        log.info("Gunluk aksiyon-odakli alert degerlendirmesi tamamlandi: {} alert", total);
    }

    /**
     * Rolling alert'ler — 15 dakikada bir.
     * HIGH_TEMP_FILES, IDLE_IN_TX_TIME_HIGH, REPLICATION_SLOT_INACTIVE
     */
    public void evaluateFrequent() {
        int total = 0;
        total += safeEval("HIGH_TEMP_FILES", this::checkHighTempFiles);
        total += safeEval("IDLE_IN_TX_TIME_HIGH", this::checkIdleInTxTimeHigh);
        total += safeEval("REPLICATION_SLOT_INACTIVE", this::checkReplicationSlotInactive);
        if (total > 0) {
            log.info("Rolling aksiyon-odakli alert: {} yeni tetiklendi", total);
        }
    }

    /**
     * Acute alert'ler — her rollup cycle'da (5 saniyede bir).
     * LONG_RUNNING_QUERY, HIGH_CONNECTION_USAGE, STALE_DATA
     * — anlik tespit gerektiren, hizli mudahale edilmesi gereken durumlar.
     */
    public void evaluateAcute() {
        int total = 0;
        total += safeEval("LONG_RUNNING_QUERY", this::checkLongRunningQuery);
        total += safeEval("HIGH_CONNECTION_USAGE", this::checkHighConnectionUsage);
        total += safeEval("STALE_DATA", this::checkStaleData);
        if (total > 0) {
            log.info("Acute aksiyon-odakli alert: {} yeni tetiklendi", total);
        }
    }

    private int safeEval(String name, java.util.function.IntSupplier fn) {
        try {
            return fn.getAsInt();
        } catch (Exception e) {
            log.warn("Actionable alert hatasi {}: {}", name, e.getMessage());
            return 0;
        }
    }

    // =========================================================================
    // 1. INDEX_SUSPECT_MISSING
    // seq_scan/idx_scan > 100, seq_tup_read > 100K, tablo > 10MB
    // =========================================================================

    private int checkIndexSuspectMissing() {
        int windowMin = configCache.getWindowMinutes("index_suspect_missing", null, 1440);
        List<Map<String, Object>> rows = jdbc.queryForList("""
            with t as (
              select t.instance_pk, t.dbid, t.schemaname, t.relname,
                     sum(t.seq_scan_delta) as seq_scans,
                     sum(t.idx_scan_delta) as idx_scans,
                     sum(t.seq_tup_read_delta) as seq_tup_read
              from fact.pg_table_stat_delta t
              where t.sample_ts > now() - make_interval(mins => ?)
              group by t.instance_pk, t.dbid, t.schemaname, t.relname
            ), sized as (
              select t.*,
                coalesce(rs.total_size_bytes, 0) as total_size_bytes,
                case when t.idx_scans > 0
                  then round(t.seq_scans::numeric / t.idx_scans, 1)
                  else 9999 end as ratio
              from t
              left join lateral (
                select total_size_bytes from fact.pg_relation_size_snapshot rs
                where rs.instance_pk = t.instance_pk and rs.dbid = t.dbid
                  and rs.schemaname = t.schemaname and rs.relname = t.relname
                order by snapshot_ts desc limit 1
              ) rs on true
            )
            select s.*, i.display_name,
                   dbr.datname
            from sized s
            join control.instance_inventory i on i.instance_pk = s.instance_pk
            left join dim.database_ref dbr on dbr.instance_pk = s.instance_pk and dbr.dbid = s.dbid
            where s.seq_scans > 0
              and (s.idx_scans = 0 or s.ratio > 0)
              and s.seq_tup_read > 100000
              and s.total_size_bytes > 10485760
            order by s.seq_tup_read desc
            limit 20
            """, windowMin);

        int count = 0;
        for (Map<String, Object> r : rows) {
            long instancePk = toLong(r.get("instance_pk"));
            // Config check: bu instance için alert aktif mi?
            if (!configCache.isEnabled("index_suspect_missing", instancePk)) continue;
            BigDecimal threshold = configCache.getThreshold(
                "index_suspect_missing", instancePk, new BigDecimal("100"));
            if (toBD(r.get("ratio")).compareTo(threshold) <= 0) continue;

            String alertKey = "actionable:index_suspect_missing:" +
                r.get("instance_pk") + ":" + r.get("dbid") + ":" +
                r.get("schemaname") + "." + r.get("relname");

            // Bu tabloya erişen top sorguları bul (query_text ILIKE '%tablename%')
            String relname = (String) r.get("relname");
            List<Map<String, Object>> relatedQueries = findQueriesForTable(instancePk, relname);

            Map<String, Object> ctx = new java.util.HashMap<>();
            ctx.put("instance", r.get("display_name"));
            ctx.put("instance_pk", r.get("instance_pk"));
            ctx.put("database", r.get("datname") != null ? r.get("datname") : "?");
            ctx.put("table", r.get("schemaname") + "." + r.get("relname"));
            ctx.put("relname", relname);
            ctx.put("table_size_human", humanBytes(toLong(r.get("total_size_bytes"))));
            ctx.put("seq_scans", r.get("seq_scans"));
            ctx.put("idx_scans", r.get("idx_scans"));
            ctx.put("seq_idx_ratio", r.get("ratio"));
            ctx.put("seq_tup_read", r.get("seq_tup_read"));
            ctx.put("top_queries", formatQueriesForMessage(relatedQueries));

            String[] rendered = renderer.renderForCode("index_suspect_missing", ctx,
                "Index gerekiyor: " + r.get("schemaname") + "." + r.get("relname"),
                "seq_scan/idx_scan oranı çok yüksek");

            String detailsJson = buildDetailsJson(relatedQueries);
            alertRepo.upsert(alertKey, AlertCode.INDEX_SUSPECT_MISSING,
                toLong(r.get("instance_pk")), null, null,
                rendered[0], rendered[1], detailsJson);
            count++;
        }
        return count;
    }

    // =========================================================================
    // 2. INDEX_UNUSED — 30g idx_scan=0, size informational only
    // =========================================================================

    private int checkIndexUnused() {
        // KÜME-AWARE: Bir index sadece "küme genelinde" idx_scan toplamı 0 ise
        // alert üretir. Read trafiği replica'da olabilir; primary'de 0 görmek
        // false positive değil. cluster_id = manuel grup veya system_identifier.
        // Standalone (cluster_id null) → eski mantık (per-instance).
        List<Map<String, Object>> rows = jdbc.queryForList("""
            with bounds as (
              select now() - interval '30 days' as window_start,
                     now() as window_end,
                     interval '6 hours' as tolerance
            ),
            per_inst as (
              select i.instance_pk, i.dbid, i.schemaname,
                     coalesce(dbr.datname, i.dbid::text) as database_key,
                     coalesce(dbr.datname, '?') as datname,
                     i.index_relname as indexrelname, i.table_relname,
                     sum(i.idx_scan_delta) as total_scans,
                     min(i.sample_ts) as observed_since,
                     max(i.sample_ts) as observed_until,
                     (min(i.sample_ts) <= b.window_start + b.tolerance
                      and max(i.sample_ts) >= b.window_end - b.tolerance) as full_window_covered
              from fact.pg_index_stat_delta i
              cross join bounds b
              left join dim.database_ref dbr on dbr.instance_pk = i.instance_pk and dbr.dbid = i.dbid
              where i.sample_ts >= b.window_start
              group by i.instance_pk, i.dbid, i.schemaname, dbr.datname, i.index_relname, i.table_relname,
                       b.window_start, b.window_end, b.tolerance
            ),
            cluster_idx as (
              -- aynı küme + aynı index ismi (tüm replikalar dahil)
              select vic.cluster_id, p.database_key, p.schemaname, p.indexrelname,
                     sum(p.total_scans) as cluster_total_scans,
                     bool_and(p.full_window_covered) as cluster_window_covered
              from per_inst p
              join control.v_instance_cluster vic on vic.instance_pk = p.instance_pk
              where vic.cluster_id is not null
              group by vic.cluster_id, p.database_key, p.schemaname, p.indexrelname
            )
            select p.*, rs.total_size_bytes, inst.display_name,
                   vic.cluster_id, ci.cluster_total_scans
            from per_inst p
            join control.instance_inventory inst on inst.instance_pk = p.instance_pk
            left join control.v_instance_cluster vic on vic.instance_pk = p.instance_pk
            left join cluster_idx ci on ci.cluster_id = vic.cluster_id
                  and ci.database_key = p.database_key
                  and ci.schemaname = p.schemaname and ci.indexrelname = p.indexrelname
            left join lateral (
              select total_size_bytes from fact.pg_relation_size_snapshot rs
              where rs.instance_pk = p.instance_pk and rs.dbid = p.dbid
                and rs.schemaname = p.schemaname and rs.relname = p.indexrelname
                and rs.relkind = 'i'
              order by snapshot_ts desc limit 1
            ) rs on true
            where p.total_scans = 0
              and p.full_window_covered
              and (
                vic.cluster_id is null                         -- standalone: bu instance'ta 0 yeter
                or (coalesce(ci.cluster_total_scans, 0) = 0 and ci.cluster_window_covered)
              )
            order by rs.total_size_bytes desc nulls last
            limit 20
            """);

        int count = 0;
        for (Map<String, Object> r : rows) {
            long instancePk = toLong(r.get("instance_pk"));
            if (!configCache.isEnabled("index_unused", instancePk)) continue;

            String alertKey = "actionable:index_unused:" +
                r.get("instance_pk") + ":" + r.get("dbid") + ":" +
                r.get("schemaname") + "." + r.get("indexrelname");

            Map<String, Object> ctx = Map.of(
                "instance", r.get("display_name"),
                "instance_pk", r.get("instance_pk"),
                "database", r.get("datname") != null ? r.get("datname") : "?",
                "index", r.get("schemaname") + "." + r.get("indexrelname"),
                "index_size_human", humanBytes(toLong(r.get("total_size_bytes")))
            );

            String[] rendered = renderer.renderForCode("index_unused", ctx,
                "Kullanılmayan index: " + r.get("schemaname") + "." + r.get("indexrelname"),
                "30 gün tam gözlemde idx_scan = 0");

            String detailsJson = new AlertDetailsBuilder()
                .setKind("usage_summary")
                .addContext("index", r.get("schemaname") + "." + r.get("indexrelname"))
                .addContext("table", r.get("table_relname"))
                .addContext("index_size_bytes", toLong(r.get("total_size_bytes")))
                .addContext("index_size_human", humanBytes(toLong(r.get("total_size_bytes"))))
                .addContext("total_scans_30d", 0)
                .addContext("observed_since", r.get("observed_since"))
                .addContext("observed_until", r.get("observed_until"))
                .build();

            alertRepo.upsert(alertKey, AlertCode.INDEX_UNUSED,
                toLong(r.get("instance_pk")), null, null,
                rendered[0], rendered[1], detailsJson);
            count++;
        }
        return count;
    }

    // =========================================================================
    // 2b. INDEX_INVALID — pg_index says index is invalid or not ready
    // =========================================================================

    private int checkIndexInvalid() {
        List<Map<String, Object>> rows = jdbc.queryForList("""
            with latest as (
              select instance_pk, dbid, index_relid, max(sample_ts) as ts
              from fact.pg_index_stat_delta
              group by instance_pk, dbid, index_relid
            )
            select i.instance_pk, inv.display_name, i.dbid, dbr.datname,
                   i.schemaname, i.table_relname, i.index_relname,
                   i.is_valid, i.is_ready, i.is_primary, i.is_unique
            from fact.pg_index_stat_delta i
            join latest l on l.instance_pk = i.instance_pk
                         and l.dbid = i.dbid
                         and l.index_relid = i.index_relid
                         and l.ts = i.sample_ts
            join control.instance_inventory inv on inv.instance_pk = i.instance_pk
            left join dim.database_ref dbr on dbr.instance_pk = i.instance_pk and dbr.dbid = i.dbid
            where coalesce(i.is_valid, true) = false
               or coalesce(i.is_ready, true) = false
            order by inv.display_name, i.schemaname, i.index_relname
            """);

        int count = 0;
        Set<String> activeAlertKeys = new HashSet<>();
        for (Map<String, Object> r : rows) {
            long instancePk = toLong(r.get("instance_pk"));

            String index = r.get("schemaname") + "." + r.get("index_relname");
            String table = r.get("schemaname") + "." + r.get("table_relname");
            String alertKey = "actionable:index_invalid:" + instancePk + ":" + r.get("dbid") + ":" + index;
            activeAlertKeys.add(alertKey);

            if (!configCache.isEnabled("index_invalid", instancePk)) continue;

            Map<String, Object> ctx = new java.util.HashMap<>();
            ctx.put("instance", r.get("display_name"));
            ctx.put("instance_pk", instancePk);
            ctx.put("database", r.get("datname") != null ? r.get("datname") : "?");
            ctx.put("index", index);
            ctx.put("table", table);
            ctx.put("is_valid", r.get("is_valid"));
            ctx.put("is_ready", r.get("is_ready"));
            ctx.put("is_primary", r.get("is_primary"));
            ctx.put("is_unique", r.get("is_unique"));

            String[] rendered = renderer.renderForCode("index_invalid", ctx,
                "Invalid index: " + index,
                "Index valid=" + r.get("is_valid") + ", ready=" + r.get("is_ready"));

            String detailsJson = new AlertDetailsBuilder()
                .setKind("usage_summary")
                .addContext("database", ctx.get("database"))
                .addContext("index", index)
                .addContext("table", table)
                .addContext("is_valid", r.get("is_valid"))
                .addContext("is_ready", r.get("is_ready"))
                .addContext("is_primary", r.get("is_primary"))
                .addContext("is_unique", r.get("is_unique"))
                .build();

            alertRepo.upsert(alertKey, AlertCode.INDEX_INVALID,
                instancePk, null, null, rendered[0], rendered[1], detailsJson);
            count++;
        }

        List<String> openKeys = jdbc.queryForList("""
            select alert_key
            from ops.alert
            where alert_code = ?
              and status = 'open'
            """, String.class, AlertCode.INDEX_INVALID.getCode());
        for (String key : openKeys) {
            if (!activeAlertKeys.contains(key)) {
                alertRepo.resolve(key);
            }
        }

        return count;
    }

    // =========================================================================
    // 3. HIGH_TEMP_FILES — temp_files > 100/saat
    // =========================================================================

    private int checkHighTempFiles() {
        // Pencere artik control.system_alert_config.window_minutes'tan okunuyor.
        // Default 15dk (job F4 = 15dk dispatch ile uyumlu).
        int windowMin = configCache.getWindowMinutes("high_temp_files", null, 15);
        List<Map<String, Object>> rows = jdbc.queryForList("""
            select d.instance_pk, d.dbid, d.datname,
                   sum(d.temp_files_delta) as temp_files,
                   sum(d.temp_bytes_delta) as temp_bytes,
                   i.display_name
            from fact.pg_database_delta d
            join control.instance_inventory i on i.instance_pk = d.instance_pk
            where d.sample_ts > now() - make_interval(mins => ?)
            group by d.instance_pk, d.dbid, d.datname, i.display_name
            having sum(d.temp_files_delta) > 0
            """, windowMin);

        int count = 0;
        for (Map<String, Object> r : rows) {
            long instancePk = toLong(r.get("instance_pk"));
            if (!configCache.isEnabled("high_temp_files", instancePk)) continue;
            // Default eşik: 15dk içinde 25 temp file (eski 100/saat'in 1/4'ü)
            BigDecimal threshold = configCache.getThreshold(
                "high_temp_files", instancePk, new BigDecimal("25"));
            if (toBD(r.get("temp_files")).compareTo(threshold) <= 0) continue;

            String alertKey = "actionable:high_temp_files:" + instancePk + ":" + r.get("dbid");

            SettingInfo workMemInfo = readSettingInfo(instancePk, "work_mem");
            SettingInfo maxConnectionsInfo = readSettingInfo(instancePk, "max_connections");
            SettingInfo sharedBuffersInfo = readSettingInfo(instancePk, "shared_buffers");
            SettingInfo effectiveCacheInfo = readSettingInfo(instancePk, "effective_cache_size");
            String workMem = formatSetting(workMemInfo, "?");
            String maxConnections = formatSetting(maxConnectionsInfo, "?");
            String sharedBuffers = formatSetting(sharedBuffersInfo, "?");
            String effectiveCacheSize = formatSetting(effectiveCacheInfo, "?");

            // Top 3 temp ureten sorgu
            List<Map<String, Object>> topTempQueries = getTopTempQueries(instancePk);

            long tempBytes = toLong(r.get("temp_bytes"));
            long maxQueryTempBytes = tempBytes;
            for (Map<String, Object> q : topTempQueries) {
                maxQueryTempBytes = Math.max(maxQueryTempBytes, toLong(q.get("temp_bytes")));
            }
            long workMemBytes = parseSettingBytes(workMemInfo, 4L * 1024L * 1024L);
            WorkMemAdvice advice = buildWorkMemAdvice(
                maxQueryTempBytes,
                workMemBytes,
                parseSettingLong(maxConnectionsInfo, 0),
                parseSettingBytes(sharedBuffersInfo, 0),
                parseSettingBytes(effectiveCacheInfo, 0)
            );
            String suggested = advice.suggestedWorkMem();
            String workMemGuidance = advice.guidance();
            // Ortalama temp/call mevcut work_mem'in altindaysa work_mem yetersizligi degil,
            // planner kararidir. Mesajda yaniltici "work_mem dusur" cikmamali.
            long avgTempPerCall = 0;
            for (Map<String, Object> q : topTempQueries) {
                long perCall = toLong(q.get("avg_temp_bytes_per_call"));
                if (perCall > avgTempPerCall) avgTempPerCall = perCall;
            }
            boolean workMemSufficient = workMemBytes > 0 && avgTempPerCall > 0
                && avgTempPerCall < workMemBytes;
            String rootCauseHint = workMemSufficient
                ? "ℹ️ Ortalama temp/call (" + humanBytes(avgTempPerCall) + ") mevcut work_mem'in altında. "
                    + "work_mem yetersizliği değil, planner kararından (parallel hash, kötü row estimate) kaynaklı. "
                    + "EXPLAIN (ANALYZE, BUFFERS) ile spill node'u inceleyin."
                : "🎯 Öneri: SET LOCAL work_mem = '" + suggested + "' (en yüksek ort. temp/call: "
                    + humanBytes(avgTempPerCall) + "). " + workMemGuidance;

            Map<String, Object> ctx = new java.util.HashMap<>();
            ctx.put("instance", r.get("display_name"));
            ctx.put("instance_pk", instancePk);
            ctx.put("database", r.get("datname"));
            ctx.put("temp_files", r.get("temp_files"));
            ctx.put("temp_bytes_human", humanBytes(tempBytes));
            ctx.put("work_mem", workMem);
            ctx.put("max_connections", maxConnections);
            ctx.put("shared_buffers", sharedBuffers);
            ctx.put("effective_cache_size", effectiveCacheSize);
            ctx.put("safe_global_work_mem", advice.safeGlobalWorkMem());
            ctx.put("top_temp_queries", formatTopTempQueriesToText(topTempQueries));
            ctx.put("suggested_work_mem", suggested);
            ctx.put("work_mem_guidance", workMemGuidance);
            ctx.put("root_cause_hint", rootCauseHint);
            ctx.put("work_mem_sufficient", workMemSufficient);

            String[] rendered = renderer.renderForCode("high_temp_files", ctx,
                "Yüksek temp file: " + r.get("datname"),
                "temp_files > " + threshold + "/saat, work_mem=" + workMem);

            // AlertDetailsBuilder ile zengin details_json
            AlertDetailsBuilder details = new AlertDetailsBuilder()
                .setKind("temp_files")
                .addContext("work_mem", workMem)
                .addContext("max_connections", maxConnections)
                .addContext("shared_buffers", sharedBuffers)
                .addContext("effective_cache_size", effectiveCacheSize)
                .addContext("suggested_work_mem", suggested)
                .addContext("safe_global_work_mem", advice.safeGlobalWorkMem())
                .addContext("work_mem_guidance", workMemGuidance)
                .addContext("temp_files", r.get("temp_files"))
                .addContext("temp_bytes", tempBytes)
                .addContext("database", r.get("datname"));
            for (Map<String, Object> q : topTempQueries) {
                Map<String, Object> rec = new java.util.LinkedHashMap<>();
                rec.put("query_text", q.get("query_text") != null ? q.get("query_text") : "?");
                rec.put("queryid", q.get("queryid"));
                rec.put("statement_series_id", q.get("statement_series_id"));
                rec.put("datname", q.get("datname"));
                rec.put("temp_bytes", toLong(q.get("temp_bytes")));
                rec.put("calls_window", toLong(q.get("calls_window")));
                rec.put("calls_28d", toLong(q.get("calls_28d")));
                rec.put("avg_temp_bytes_per_call", toLong(q.get("avg_temp_bytes_per_call")));
                rec.put("current_val", toLong(q.get("temp_bytes")));
                rec.put("label", "temp_bytes");
                details.addRecord(rec);
            }

            alertRepo.upsert(alertKey, AlertCode.HIGH_TEMP_FILES,
                instancePk, null, null, rendered[0], rendered[1], details.build());
            count++;
        }
        return count;
    }

    // =========================================================================
    // 3b. HIGH_TEMP_FILES_DAILY - temp_files > threshold / 24h
    // =========================================================================

    private int checkHighTempFilesDaily() {
        int windowMin = configCache.getWindowMinutes("high_temp_files_daily", null, 1440);
        List<Map<String, Object>> rows = jdbc.queryForList("""
            select d.instance_pk, d.dbid, d.datname,
                   sum(d.temp_files_delta) as temp_files,
                   sum(d.temp_bytes_delta) as temp_bytes,
                   i.display_name
            from fact.pg_database_delta d
            join control.instance_inventory i on i.instance_pk = d.instance_pk
            where d.sample_ts > now() - make_interval(mins => ?)
            group by d.instance_pk, d.dbid, d.datname, i.display_name
            having sum(d.temp_files_delta) > 0
            """, windowMin);

        int count = 0;
        for (Map<String, Object> r : rows) {
            long instancePk = toLong(r.get("instance_pk"));
            if (!configCache.isEnabled("high_temp_files_daily", instancePk)) continue;
            BigDecimal threshold = configCache.getThreshold(
                "high_temp_files_daily", instancePk, new BigDecimal("1000"));
            if (toBD(r.get("temp_files")).compareTo(threshold) <= 0) continue;

            long tempBytes = toLong(r.get("temp_bytes"));
            String alertKey = "actionable:high_temp_files_daily:" + instancePk + ":" + r.get("dbid");

            Map<String, Object> ctx = new java.util.HashMap<>();
            ctx.put("instance", r.get("display_name"));
            ctx.put("instance_pk", instancePk);
            ctx.put("database", r.get("datname"));
            ctx.put("temp_files", r.get("temp_files"));
            ctx.put("temp_bytes_human", humanBytes(tempBytes));

            String[] rendered = renderer.renderForCode("high_temp_files_daily", ctx,
                "Gunluk yuksek temp file: " + r.get("datname"),
                "temp_files > " + threshold + "/24h");

            String detailsJson = new AlertDetailsBuilder()
                .setKind("temp_files")
                .addContext("database", r.get("datname"))
                .addContext("temp_files", r.get("temp_files"))
                .addContext("temp_bytes", tempBytes)
                .addContext("window", "24h")
                .build();

            alertRepo.upsert(alertKey, AlertCode.HIGH_TEMP_FILES_DAILY,
                instancePk, null, null, rendered[0], rendered[1], detailsJson);
            count++;
        }
        return count;
    }

    private int checkHighTempSqlsDaily() {
        int windowMin = configCache.getWindowMinutes("high_temp_sqls_daily", null, 1440);
        List<Map<String, Object>> rows = jdbc.queryForList("""
            with per_sql as (
              select d.instance_pk,
                     ss.dbid,
                     coalesce(dbr.datname, '?') as datname,
                     ss.statement_series_id,
                     ss.queryid,
                     coalesce(qt.query_text, '?') as query_text,
                     sum(coalesce(d.temp_blks_written_delta, 0)) * 8192 as temp_bytes
              from fact.pgss_delta d
              join dim.statement_series ss on ss.statement_series_id = d.statement_series_id
              left join dim.database_ref dbr on dbr.instance_pk = ss.instance_pk and dbr.dbid = ss.dbid
              left join dim.query_text qt on qt.query_text_id = ss.query_text_id
              where d.sample_ts > now() - make_interval(mins => ?)
                and coalesce(d.temp_blks_written_delta, 0) > 0
              group by d.instance_pk, ss.dbid, dbr.datname, ss.statement_series_id, ss.queryid, qt.query_text
              having sum(coalesce(d.temp_blks_written_delta, 0)) * 8192 >= ?
            ),
            ranked as (
              select p.*,
                     row_number() over (partition by p.instance_pk, p.dbid order by p.temp_bytes desc) as rn
              from per_sql p
            ),
            agg as (
              select instance_pk, dbid, datname,
                     count(*) as sql_count,
                     sum(temp_bytes) as temp_bytes
              from per_sql
              group by instance_pk, dbid, datname
            ),
            top_queries as (
              select instance_pk, dbid,
                     string_agg(
                       left(query_text, 120) || ' -> ' || pg_size_pretty(temp_bytes::bigint),
                       E'\n' order by temp_bytes desc
                     ) as top_temp_queries
              from ranked
              where rn <= 5
              group by instance_pk, dbid
            )
            select a.*, tq.top_temp_queries, i.display_name
            from agg a
            join control.instance_inventory i on i.instance_pk = a.instance_pk
            left join top_queries tq on tq.instance_pk = a.instance_pk and tq.dbid = a.dbid
            """, windowMin, DAILY_TEMP_SQL_MIN_BYTES);

        int count = 0;
        for (Map<String, Object> r : rows) {
            long instancePk = toLong(r.get("instance_pk"));
            if (!configCache.isEnabled("high_temp_sqls_daily", instancePk)) continue;
            BigDecimal threshold = configCache.getThreshold(
                "high_temp_sqls_daily", instancePk, new BigDecimal("10"));
            if (toBD(r.get("sql_count")).compareTo(threshold) <= 0) continue;

            long tempBytes = toLong(r.get("temp_bytes"));
            String alertKey = "actionable:high_temp_sqls_daily:" + instancePk + ":" + r.get("dbid");

            Map<String, Object> ctx = new java.util.HashMap<>();
            ctx.put("instance", r.get("display_name"));
            ctx.put("instance_pk", instancePk);
            ctx.put("database", r.get("datname"));
            ctx.put("sql_count", r.get("sql_count"));
            ctx.put("min_temp_mb_per_sql", DAILY_TEMP_SQL_MIN_MB);
            ctx.put("temp_bytes_human", humanBytes(tempBytes));
            ctx.put("top_temp_queries", r.get("top_temp_queries") != null ? r.get("top_temp_queries") : "(veri yok)");

            String[] rendered = renderer.renderForCode("high_temp_sqls_daily", ctx,
                "Temp-heavy SQL sayisi yuksek: " + r.get("datname"),
                r.get("sql_count") + " SQL >= " + DAILY_TEMP_SQL_MIN_MB + "MB temp yazdi");

            String detailsJson = new AlertDetailsBuilder()
                .setKind("temp_files")
                .addContext("database", r.get("datname"))
                .addContext("sql_count", r.get("sql_count"))
                .addContext("min_temp_bytes_per_sql", DAILY_TEMP_SQL_MIN_BYTES)
                .addContext("min_temp_mb_per_sql", DAILY_TEMP_SQL_MIN_MB)
                .addContext("temp_bytes", tempBytes)
                .addContext("top_temp_queries", r.get("top_temp_queries"))
                .addContext("window", "24h")
                .build();

            alertRepo.upsert(alertKey, AlertCode.HIGH_TEMP_SQLS_DAILY,
                instancePk, null, null, rendered[0], rendered[1], detailsJson);
            count++;
        }
        return count;
    }

    // =========================================================================
    // 4. IDLE_IN_TX_TIME_HIGH - idle_in_tx / session > 30% (PG14+)
    // =========================================================================

    private int checkIdleInTxTimeHigh() {
        // idle_in_transaction_time_ms_delta kolonu PG14+ icin var
        // Kolon yoksa sorgu hata verir → graceful skip (safeEval yakalar)
        int windowMin = configCache.getWindowMinutes("idle_in_tx_time_high", null, 60);
        List<Map<String, Object>> rows = jdbc.queryForList("""
            select d.instance_pk, d.dbid, d.datname,
                   sum(d.idle_in_transaction_time_ms_delta) as idle_ms,
                   sum(d.session_time_ms_delta) as session_ms,
                   round(100.0 * sum(d.idle_in_transaction_time_ms_delta)::numeric /
                         nullif(sum(d.session_time_ms_delta), 0), 1) as idle_pct,
                   i.display_name
            from fact.pg_database_delta d
            join control.instance_inventory i on i.instance_pk = d.instance_pk
            where d.sample_ts > now() - make_interval(mins => ?)
            group by d.instance_pk, d.dbid, d.datname, i.display_name
            having sum(d.session_time_ms_delta) > 60000
            """, windowMin);

        int count = 0;
        for (Map<String, Object> r : rows) {
            long instancePk = toLong(r.get("instance_pk"));
            if (!configCache.isEnabled("idle_in_tx_time_high", instancePk)) continue;
            BigDecimal threshold = configCache.getThreshold(
                "idle_in_tx_time_high", instancePk, new BigDecimal("30"));
            if (toBD(r.get("idle_pct")).compareTo(threshold) <= 0) continue;

            String alertKey = "actionable:idle_in_tx:" + r.get("instance_pk") + ":" + r.get("dbid");

            Map<String, Object> ctx = new java.util.HashMap<>();
            ctx.put("instance", r.get("display_name"));
            ctx.put("instance_pk", r.get("instance_pk"));
            ctx.put("database", r.get("datname"));
            ctx.put("idle_in_tx_time_human", humanMs(toLong(r.get("idle_ms"))));
            ctx.put("session_time_human", humanMs(toLong(r.get("session_ms"))));
            ctx.put("idle_pct", r.get("idle_pct"));

            String[] rendered = renderer.renderForCode("idle_in_tx_time_high", ctx,
                "Idle in tx yüksek: " + r.get("datname"),
                "idle_in_tx / session > 30%");

            // Connection diagnostics details
            String detailsJson = new AlertDetailsBuilder()
                .setKind("connection_diag")
                .addContext("database", r.get("datname"))
                .addContext("idle_in_tx_ms", toLong(r.get("idle_ms")))
                .addContext("session_ms", toLong(r.get("session_ms")))
                .addContext("idle_pct", r.get("idle_pct"))
                .build();

            alertRepo.upsert(alertKey, AlertCode.IDLE_IN_TX_TIME_HIGH,
                toLong(r.get("instance_pk")), null, null,
                rendered[0], rendered[1], detailsJson);
            count++;
        }
        return count;
    }

    // =========================================================================
    // 5. REPLICATION_SLOT_INACTIVE — 1h inactive, lag > 1GB
    // =========================================================================

    private int checkReplicationSlotInactive() {
        // Pencere = "kac dakikadir slot inactive". Latest snapshot lookup ve
        // "bu pencerede aktif degil mi" kontrolu ayni pencereyi kullanir.
        int windowMin = configCache.getWindowMinutes("replication_slot_inactive", null, 60);
        List<Map<String, Object>> rows = jdbc.queryForList("""
            with latest as (
              select instance_pk, slot_name, max(sample_ts) as ts
              from fact.pg_replication_slot_snapshot
              where sample_ts > now() - make_interval(mins => ?)
              group by instance_pk, slot_name
            )
            select s.instance_pk, s.slot_name, s.slot_type, s.wal_status, s.slot_lag_bytes,
                   i.display_name
            from fact.pg_replication_slot_snapshot s
            join latest l on l.instance_pk = s.instance_pk and l.slot_name = s.slot_name and l.ts = s.sample_ts
            join control.instance_inventory i on i.instance_pk = s.instance_pk
            where s.active = false
              and s.slot_lag_bytes > 0
              and not exists (
                select 1 from fact.pg_replication_slot_snapshot s2
                where s2.instance_pk = s.instance_pk and s2.slot_name = s.slot_name
                  and s2.sample_ts > now() - make_interval(mins => ?)
                  and s2.active = true
              )
            """, windowMin, windowMin);

        int count = 0;
        for (Map<String, Object> r : rows) {
            long instancePk = toLong(r.get("instance_pk"));
            if (!configCache.isEnabled("replication_slot_inactive", instancePk)) continue;
            long thresholdBytes = configCache.getThreshold(
                "replication_slot_inactive", instancePk, new BigDecimal("1024")).longValue() * 1_048_576L;
            if (toLong(r.get("slot_lag_bytes")) <= thresholdBytes) continue;

            String alertKey = "actionable:slot_inactive:" + r.get("instance_pk") + ":" + r.get("slot_name");

            Map<String, Object> ctx = new java.util.HashMap<>();
            ctx.put("instance", r.get("display_name"));
            ctx.put("instance_pk", r.get("instance_pk"));
            ctx.put("slot_name", r.get("slot_name"));
            ctx.put("slot_type", r.get("slot_type"));
            ctx.put("slot_lag_human", humanBytes(toLong(r.get("slot_lag_bytes"))));

            String[] rendered = renderer.renderForCode("replication_slot_inactive", ctx,
                "Inactive slot: " + r.get("slot_name"),
                "1h inactive, lag > 1GB");

            String detailsJson = new AlertDetailsBuilder()
                .setKind("usage_summary")
                .addContext("slot_name", r.get("slot_name"))
                .addContext("slot_type", r.get("slot_type"))
                .addContext("slot_lag_bytes", toLong(r.get("slot_lag_bytes")))
                .addContext("slot_lag_human", humanBytes(toLong(r.get("slot_lag_bytes"))))
                .addContext("wal_status", r.get("wal_status"))
                .build();

            alertRepo.upsert(alertKey, AlertCode.REPLICATION_SLOT_INACTIVE,
                toLong(r.get("instance_pk")), null, null,
                rendered[0], rendered[1], detailsJson);
            count++;
        }
        return count;
    }

    // =========================================================================
    // 6. LONG_RUNNING_QUERY — 5dk+ calisan sorgular (acute)
    // =========================================================================

    private int checkLongRunningQuery() {
        // pg_activity_snapshot'tan son snapshot'taki 5dk+ calisan sorgulari bul
        List<Map<String, Object>> rows = jdbc.queryForList("""
            with latest as (
              select instance_pk, max(snapshot_ts) as ts
              from fact.pg_activity_snapshot
              group by instance_pk
            )
            select a.instance_pk, i.display_name, a.pid, a.datname, a.usename,
                   a.application_name, a.state,
                   extract(epoch from (l.ts - a.query_start))::bigint as duration_seconds,
                   left(a.query, 200) as query_text
            from fact.pg_activity_snapshot a
            join control.instance_inventory i on i.instance_pk = a.instance_pk
            join latest l on l.instance_pk = a.instance_pk and l.ts = a.snapshot_ts
            where true
              and a.state = 'active'
              and a.query_start is not null
              and a.backend_type = 'client backend'
            order by duration_seconds desc
            limit 20
            """);

        int count = 0;
        for (Map<String, Object> r : rows) {
            long instancePk = toLong(r.get("instance_pk"));
            if (!configCache.isEnabled("long_running_query", instancePk)) continue;
            BigDecimal threshold = configCache.getThreshold(
                "long_running_query", instancePk, new BigDecimal("300"));
            if (toBD(r.get("duration_seconds")).compareTo(threshold) <= 0) continue;

            String alertKey = "actionable:long_running_query:" + instancePk + ":" + r.get("pid");

            Map<String, Object> ctx = new java.util.HashMap<>();
            ctx.put("instance", r.get("display_name"));
            ctx.put("instance_pk", instancePk);
            ctx.put("database", r.get("datname"));
            ctx.put("pid", r.get("pid"));
            ctx.put("username", r.get("usename"));
            ctx.put("duration_seconds", r.get("duration_seconds"));
            ctx.put("query_snippet", r.get("query_text"));

            String[] rendered = renderer.renderForCode("long_running_query", ctx,
                "Uzun sorgu: PID " + r.get("pid"),
                "Sorgu " + r.get("duration_seconds") + " saniyedir çalışıyor");

            String detailsJson = new AlertDetailsBuilder()
                .setKind("connection_diag")
                .addContext("pid", r.get("pid"))
                .addContext("database", r.get("datname"))
                .addContext("user", r.get("usename"))
                .addContext("application", r.get("application_name"))
                .addContext("duration_seconds", r.get("duration_seconds"))
                .addContext("query", r.get("query_text"))
                .build();

            alertRepo.upsert(alertKey, AlertCode.LONG_RUNNING_QUERY,
                instancePk, null, null, rendered[0], rendered[1], detailsJson);
            count++;
        }
        return count;
    }

    // =========================================================================
    // 7. HIGH_CONNECTION_USAGE — numbackends / max_connections > %80 (acute)
    // =========================================================================

    private int checkHighConnectionUsage() {
        // Son snapshot'taki backend sayisi vs max_connections.
        // "5 minutes" pencere DEGIL — son taze snapshot'i bulan sentinel (veri yoksa skip).
        List<Map<String, Object>> rows = jdbc.queryForList("""
            with latest as (
              select instance_pk, max(sample_ts) as ts
              from fact.pg_database_delta
              where sample_ts > now() - interval '5 minutes'
              group by instance_pk
            ),
            conn_count as (
              select d.instance_pk, sum(d.numbackends) as total_backends
              from fact.pg_database_delta d
              join latest l on l.instance_pk = d.instance_pk and l.ts = d.sample_ts
              group by d.instance_pk
            ),
            max_conn as (
              select distinct on (instance_pk)
                     instance_pk,
                     nullif(setting_value, '')::integer as max_connections
              from fact.pg_settings_snapshot
              where setting_name = 'max_connections'
              order by instance_pk, snapshot_ts desc
            )
            select c.instance_pk, i.display_name, c.total_backends,
                   m.max_connections,
                   round(100.0 * c.total_backends / nullif(m.max_connections, 0), 1) as usage_pct
            from conn_count c
            join control.instance_inventory i on i.instance_pk = c.instance_pk
            join max_conn m on m.instance_pk = c.instance_pk
            where m.max_connections is not null
            """);

        int count = 0;
        for (Map<String, Object> r : rows) {
            long instancePk = toLong(r.get("instance_pk"));
            if (!configCache.isEnabled("high_connection_usage", instancePk)) continue;
            BigDecimal threshold = configCache.getThreshold(
                "high_connection_usage", instancePk, new BigDecimal("80"));
            if (toBD(r.get("usage_pct")).compareTo(threshold) <= 0) continue;

            String alertKey = "actionable:high_connection_usage:" + instancePk;

            Map<String, Object> ctx = new java.util.HashMap<>();
            ctx.put("instance", r.get("display_name"));
            ctx.put("instance_pk", instancePk);
            ctx.put("value", r.get("total_backends"));
            ctx.put("max_value", r.get("max_connections"));
            ctx.put("usage_pct", r.get("usage_pct"));

            String[] rendered = renderer.renderForCode("high_connection_usage", ctx,
                "Bağlantı doluyor: " + r.get("display_name"),
                r.get("total_backends") + "/" + r.get("max_connections") + " bağlantı");

            String detailsJson = new AlertDetailsBuilder()
                .setKind("connection_diag")
                .addContext("total_backends", r.get("total_backends"))
                .addContext("max_connections", r.get("max_connections"))
                .addContext("usage_pct", r.get("usage_pct"))
                .build();

            alertRepo.upsert(alertKey, AlertCode.HIGH_CONNECTION_USAGE,
                instancePk, null, null, rendered[0], rendered[1], detailsJson);
            count++;
        }
        return count;
    }

    // =========================================================================
    // 8. STALE_DATA — 10dk+ veri toplanamayan instance (acute)
    // =========================================================================

    private int checkStaleData() {
        // instance_state'ten son basarili toplama zamani 10dk'dan eski olanlar
        List<Map<String, Object>> rows = jdbc.queryForList("""
            select i.instance_pk, i.display_name, i.bootstrap_state,
                   s.last_cluster_collect_at,
                   s.consecutive_failures,
                   s.last_error,
                   extract(epoch from (now() - s.last_cluster_collect_at))::bigint as stale_seconds
            from control.instance_inventory i
            join control.instance_state s on s.instance_pk = i.instance_pk
            where i.is_active
              and i.bootstrap_state = 'ready'
              and s.last_cluster_collect_at is not null
              and s.last_cluster_collect_at < now() - make_interval(mins => ?)
            """, configCache.getWindowMinutes("stale_data", null, 10));

        int count = 0;
        for (Map<String, Object> r : rows) {
            long instancePk = toLong(r.get("instance_pk"));
            if (!configCache.isEnabled("stale_data", instancePk)) continue;

            String alertKey = "actionable:stale_data:" + instancePk;

            long staleSec = toLong(r.get("stale_seconds"));
            String staleHuman = staleSec >= 3600 ? (staleSec / 3600) + " saat"
                : staleSec >= 60 ? (staleSec / 60) + " dk" : staleSec + " sn";

            Map<String, Object> ctx = new java.util.HashMap<>();
            ctx.put("instance", r.get("display_name"));
            ctx.put("instance_pk", instancePk);
            ctx.put("minutes", staleSec / 60);
            ctx.put("last_successful_at", r.get("last_cluster_collect_at"));

            String[] rendered = renderer.renderForCode("stale_data", ctx,
                "Veri toplama durdu: " + r.get("display_name"),
                staleHuman + " süredir veri toplanamıyor");

            String detailsJson = new AlertDetailsBuilder()
                .setKind("data_quality")
                .addContext("last_success", r.get("last_cluster_collect_at"))
                .addContext("stale_duration", staleHuman)
                .addContext("consecutive_failures", r.get("consecutive_failures"))
                .addContext("last_error", r.get("last_error"))
                .build();

            alertRepo.upsert(alertKey, AlertCode.STALE_DATA,
                instancePk, null, null, rendered[0], rendered[1], detailsJson);
            count++;
        }
        return count;
    }

    // =========================================================================
    // 9. HIGH_BLOAT_RATIO — dead tuple > %20, tablo > 10MB (daily)
    // =========================================================================

    private int checkHighBloatRatio() {
        List<Map<String, Object>> rows = jdbc.queryForList("""
            with latest as (
              select instance_pk, max(sample_ts) as ts
              from fact.pg_table_stat_delta
              group by instance_pk
            )
            select t.instance_pk, i.display_name, t.schemaname, t.relname,
                   t.n_live_tup_estimate as live_tup,
                   t.n_dead_tup_estimate as dead_tup,
                   round(100.0 * t.n_dead_tup_estimate::numeric /
                         nullif(t.n_live_tup_estimate + t.n_dead_tup_estimate, 0), 1) as dead_pct,
                   coalesce(rs.total_size_bytes, 0) as table_size_bytes,
                   dbr.datname
            from fact.pg_table_stat_delta t
            join latest l on l.instance_pk = t.instance_pk and l.ts = t.sample_ts
            join control.instance_inventory i on i.instance_pk = t.instance_pk
            left join dim.database_ref dbr on dbr.instance_pk = t.instance_pk and dbr.dbid = t.dbid
            left join lateral (
              select total_size_bytes from fact.pg_relation_size_snapshot rs
              where rs.instance_pk = t.instance_pk and rs.dbid = t.dbid
                and rs.schemaname = t.schemaname and rs.relname = t.relname
              order by snapshot_ts desc limit 1
            ) rs on true
            where (t.n_live_tup_estimate + t.n_dead_tup_estimate) > 1000
              and t.n_dead_tup_estimate > 0
              and coalesce(rs.total_size_bytes, 0) > 10485760
            order by dead_pct desc
            limit 20
            """);

        int count = 0;
        for (Map<String, Object> r : rows) {
            long instancePk = toLong(r.get("instance_pk"));
            if (!configCache.isEnabled("high_bloat_ratio", instancePk)) continue;
            BigDecimal threshold = configCache.getThreshold(
                "high_bloat_ratio", instancePk, new BigDecimal("20"));
            if (toBD(r.get("dead_pct")).compareTo(threshold) <= 0) continue;

            String relation = r.get("schemaname") + "." + r.get("relname");
            String alertKey = "actionable:high_bloat:" + instancePk + ":" + relation;

            Map<String, Object> ctx = new java.util.HashMap<>();
            ctx.put("instance", r.get("display_name"));
            ctx.put("instance_pk", instancePk);
            ctx.put("relation", relation);
            ctx.put("database", r.get("datname") != null ? r.get("datname") : "?");
            ctx.put("bloat_pct", r.get("dead_pct"));
            ctx.put("total_size", humanBytes(toLong(r.get("table_size_bytes"))));

            String[] rendered = renderer.renderForCode("high_bloat_ratio", ctx,
                "Bloat yüksek: " + relation,
                "Dead tuple oranı %" + r.get("dead_pct"));

            String detailsJson = new AlertDetailsBuilder()
                .setKind("usage_summary")
                .addContext("relation", relation)
                .addContext("database", r.get("datname"))
                .addContext("live_tup", r.get("live_tup"))
                .addContext("dead_tup", r.get("dead_tup"))
                .addContext("dead_pct", r.get("dead_pct"))
                .addContext("table_size", humanBytes(toLong(r.get("table_size_bytes"))))
                .build();

            alertRepo.upsert(alertKey, AlertCode.HIGH_BLOAT_RATIO,
                instancePk, null, null, rendered[0], rendered[1], detailsJson);
            count++;
        }
        return count;
    }

    // =========================================================================
    // Yardimci
    // =========================================================================

    /**
     * Alert message template'i için sorguları text formatına çevir.
     */
    private String formatQueriesForMessage(List<Map<String, Object>> queries) {
        if (queries.isEmpty()) return "(bu tabloya erişen sorgu bulunamadı)";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < queries.size(); i++) {
            if (i > 0) sb.append("\n");
            Map<String, Object> q = queries.get(i);
            String queryText = (String) q.get("query_text");
            // Query uzunsa kısalt (message template'te göstermek için)
            if (queryText != null && queryText.length() > 80) {
                queryText = queryText.substring(0, 80) + "...";
            }
            sb.append(i + 1).append(". `").append(queryText).append("`");
            sb.append(" — ").append(q.get("datname")).append(" ");
            sb.append(q.get("calls")).append(" calls, ");
            sb.append(humanMs(toLong(q.get("exec_ms")))).append(" exec");
        }
        return sb.toString();
    }

    /**
     * Alert detail'da göstermek için details_json string'i oluştur (genel sorgu sonuçları).
     * queries: statement_series_id, queryid, query_text, datname, calls, exec_ms içeren map'ler
     */
    private String buildDetailsJson(List<Map<String, Object>> queries) {
        if (queries.isEmpty()) return null;

        StringBuilder sb = new StringBuilder();
        sb.append("{\"records\":[");
        for (int i = 0; i < queries.size(); i++) {
            if (i > 0) sb.append(",");
            Map<String, Object> q = queries.get(i);
            sb.append("{");
            sb.append("\"statement_series_id\":").append(q.get("statement_series_id"));
            sb.append(",\"queryid\":").append(q.get("queryid"));
            sb.append(",\"query_text\":").append(escapeJson((String) q.get("query_text")));
            sb.append(",\"datname\":").append(escapeJson((String) q.get("datname")));
            sb.append(",\"current_val\":").append(toLong(q.get("exec_ms")));
            sb.append(",\"prev_val\":null");
            sb.append(",\"change_pct\":null");
            sb.append(",\"label\":\"exec_ms\"");
            sb.append("}");
        }
        sb.append("]}");
        return sb.toString();
    }

    /**
     * Temp file alert için details_json (temp_bytes etiketi ile)
     */
    private String buildDetailsJsonForTempQueries(List<Map<String, Object>> queries) {
        if (queries.isEmpty()) return null;

        StringBuilder sb = new StringBuilder();
        sb.append("{\"records\":[");
        for (int i = 0; i < queries.size(); i++) {
            if (i > 0) sb.append(",");
            Map<String, Object> q = queries.get(i);
            sb.append("{");
            sb.append("\"statement_series_id\":").append(q.get("statement_series_id"));
            sb.append(",\"queryid\":").append(q.get("queryid"));
            sb.append(",\"query_text\":").append(escapeJson((String) q.get("query_text")));
            sb.append(",\"current_val\":").append(toLong(q.get("temp_bytes")));
            sb.append(",\"prev_val\":null");
            sb.append(",\"change_pct\":null");
            sb.append(",\"label\":\"temp_bytes\"");
            sb.append("}");
        }
        sb.append("]}");
        return sb.toString();
    }

    /** JSON string içine güvenli escape */
    private static String escapeJson(String s) {
        if (s == null) return "null";
        StringBuilder sb = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 32) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        sb.append("\"");
        return sb.toString();
    }

    /**
     * Belirli bir tabloya erişen top 5 sorguyu bulur.
     * Structured records döner: statement_series_id, queryid, query_text, datname, calls, exec_ms
     * UI'da Link to /statements/:id oluşturmak için statement_series_id gerekli.
     */
    private List<Map<String, Object>> findQueriesForTable(long instancePk, String relname) {
        try {
            return jdbc.queryForList(
                "select ss.statement_series_id, ss.queryid, " +
                "       coalesce(dbr.datname, '?') as datname, " +
                "       qt.query_text, " +
                "       sum(d.calls_delta) as calls, " +
                "       sum(d.total_exec_time_ms_delta) as exec_ms " +
                "from fact.pgss_delta d " +
                "join dim.statement_series ss on ss.statement_series_id = d.statement_series_id " +
                "left join dim.query_text qt on qt.query_text_id = ss.query_text_id " +
                "left join dim.database_ref dbr on dbr.instance_pk = ss.instance_pk and dbr.dbid = ss.dbid " +
                "where d.instance_pk = ? and d.sample_ts > now() - interval '24 hours' " +
                "  and qt.query_text ilike '%' || ? || '%' " +
                "group by ss.statement_series_id, ss.queryid, dbr.datname, qt.query_text " +
                "order by exec_ms desc limit 5",
                instancePk, relname);
        } catch (Exception e) {
            return java.util.Collections.emptyList();
        }
    }

    /** Top temp kullanıcısı sorguları — structured records */
    private List<Map<String, Object>> getTopTempQueries(long instancePk) {
        int windowMin = configCache.getWindowMinutes("high_temp_files", instancePk, 15);
        try {
            return jdbc.queryForList("""
                with window_q as (
                    select ss.statement_series_id,
                           ss.queryid,
                           ss.dbid,
                           qt.query_text,
                           sum(d.temp_blks_written_delta) * 8192 as temp_bytes,
                           sum(d.calls_delta) as calls_window
                    from fact.pgss_delta d
                    join dim.statement_series ss on ss.statement_series_id = d.statement_series_id
                    left join dim.query_text qt on qt.query_text_id = ss.query_text_id
                    where d.instance_pk = ? and d.sample_ts > now() - make_interval(mins => ?)
                      and d.temp_blks_written_delta > 0
                    group by ss.statement_series_id, ss.queryid, ss.dbid, qt.query_text
                    order by temp_bytes desc limit 3
                ),
                hist as (
                    select ss.statement_series_id,
                           sum(d.calls_delta) as calls_28d
                    from fact.pgss_delta d
                    join dim.statement_series ss on ss.statement_series_id = d.statement_series_id
                    where d.instance_pk = ?
                      and ss.statement_series_id in (select statement_series_id from window_q)
                      and d.sample_ts > now() - interval '28 days'
                    group by ss.statement_series_id
                )
                select w.statement_series_id, w.queryid, w.query_text,
                       w.temp_bytes, w.calls_window,
                       coalesce(h.calls_28d, 0) as calls_28d,
                       dbr.datname,
                       case when w.calls_window > 0
                            then w.temp_bytes / w.calls_window else 0 end as avg_temp_bytes_per_call
                from window_q w
                left join hist h using (statement_series_id)
                left join dim.database_ref dbr on dbr.instance_pk = ? and dbr.dbid = w.dbid
                order by w.temp_bytes desc
                """, instancePk, windowMin, instancePk, instancePk);
        } catch (Exception e) {
            return java.util.Collections.emptyList();
        }
    }

    private String formatTopTempQueriesToText(List<Map<String, Object>> queries) {
        if (queries.isEmpty()) return "(veri yok)";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < queries.size(); i++) {
            if (i > 0) sb.append("\n");
            String queryText = (String) queries.get(i).get("query_text");
            if (queryText != null && queryText.length() > 120) {
                queryText = queryText.substring(0, 120) + "...";
            }
            long total = toLong(queries.get(i).get("temp_bytes"));
            long calls = toLong(queries.get(i).get("calls_window"));
            long perCall = calls > 0 ? total / calls : 0;
            sb.append(i + 1).append(". ")
              .append(humanBytes(perCall)).append("/çağrı × ")
              .append(calls).append(" çağrı = ")
              .append(humanBytes(total)).append(" toplam\n   `")
              .append(queryText).append("`");
        }
        return sb.toString();
    }

    private String buildTopTempQueries(long instancePk) {
        return formatTopTempQueriesToText(getTopTempQueries(instancePk));
    }

    private record SettingInfo(String value, String unit) {}
    private record WorkMemAdvice(String suggestedWorkMem, String safeGlobalWorkMem, String guidance) {}

    private SettingInfo readSettingInfo(long instancePk, String settingName) {
        try {
            List<Map<String, Object>> rows = jdbc.queryForList(
                "select setting_value, unit from fact.pg_settings_snapshot " +
                "where instance_pk = ? and setting_name = ? " +
                "order by snapshot_ts desc limit 1",
                instancePk, settingName);
            if (rows.isEmpty()) return null;
            Map<String, Object> row = rows.get(0);
            return new SettingInfo(
                row.get("setting_value") != null ? row.get("setting_value").toString() : null,
                row.get("unit") != null ? row.get("unit").toString() : null
            );
        } catch (Exception ignore) {
            return null;
        }
    }

    private WorkMemAdvice buildWorkMemAdvice(long tempBytes, long currentWorkMemBytes,
                                             long maxConnections, long sharedBuffersBytes,
                                             long effectiveCacheBytes) {
        long queryNeedBytes = suggestQueryLocalWorkMemBytes(tempBytes, currentWorkMemBytes);
        long safeGlobalBytes = estimateSafeGlobalWorkMemBytes(
            maxConnections, sharedBuffersBytes, effectiveCacheBytes);

        long suggestedBytes = queryNeedBytes;
        if (safeGlobalBytes > 0 && suggestedBytes > safeGlobalBytes) {
            suggestedBytes = safeGlobalBytes;
        }
        if (currentWorkMemBytes > 0 && suggestedBytes < currentWorkMemBytes) {
            suggestedBytes = currentWorkMemBytes;
        }

        String suggested = humanWorkMem(roundWorkMemBytes(suggestedBytes, false));
        String safeGlobal = safeGlobalBytes > 0 ? humanWorkMem(roundWorkMemBytes(safeGlobalBytes, false)) : "?";

        String guidance = safeGlobalBytes > 0
            ? "Query/session onerisi: SET LOCAL work_mem = '" + suggested + "'. " +
              "Konservatif global ust sinir ~= " + safeGlobal +
              " (effective_cache_size proxy; (effective_cache_size - shared_buffers) / max_connections / 2). " +
              "effective_cache_size gercek RAM degildir, planner cache tahminidir."
            : "Query/session onerisi: SET LOCAL work_mem = '" + suggested + "'. " +
              "Global ust sinir hesaplanamadi; max_connections/shared_buffers/effective_cache_size snapshot eksik.";
        return new WorkMemAdvice(suggested, safeGlobal, guidance);
    }

    private long suggestQueryLocalWorkMemBytes(long tempBytes, long currentWorkMemBytes) {
        long tempBasedBytes = Math.max(16L * 1024L * 1024L, tempBytes / 10L);
        long base = Math.max(currentWorkMemBytes, tempBasedBytes);
        return Math.min(base, 512L * 1024L * 1024L);
    }

    private long estimateSafeGlobalWorkMemBytes(long maxConnections, long sharedBuffersBytes,
                                                long effectiveCacheBytes) {
        if (maxConnections <= 0 || effectiveCacheBytes <= 0) return 0;
        // effective_cache_size usually includes shared_buffers; subtract it to avoid double counting.
        long memoryProxy = effectiveCacheBytes > sharedBuffersBytes
            ? effectiveCacheBytes - sharedBuffersBytes
            : effectiveCacheBytes / 2L;
        if (memoryProxy <= 0) return 0;
        long perConnection = memoryProxy / maxConnections;
        long sortHashConcurrencyFactor = 2L;
        long safe = perConnection / sortHashConcurrencyFactor;
        if (safe < 1L * 1024L * 1024L) return 0;
        return Math.min(safe, 512L * 1024L * 1024L);
    }

    private static String formatSetting(SettingInfo setting, String fallback) {
        if (setting == null || setting.value() == null || setting.value().isBlank()) return fallback;
        String val = setting.value().trim();
        String unit = setting.unit() != null ? setting.unit().trim() : "";
        // value zaten birim icerirse (ornek: "10485kB") unit'i ekleme
        if (!unit.isBlank() && val.matches("^[0-9]+(?:\\.[0-9]+)?\\s*[a-zA-Z]+$")) {
            return val;
        }
        return unit.isBlank() ? val : val + unit;
    }

    private static long parseSettingLong(SettingInfo setting, long fallback) {
        if (setting == null || setting.value() == null) return fallback;
        try {
            return Long.parseLong(setting.value().trim());
        } catch (Exception e) {
            return fallback;
        }
    }

    private static long parseSettingBytes(SettingInfo setting, long fallbackBytes) {
        if (setting == null || setting.value() == null) return fallbackBytes;
        try {
            String raw = setting.value().trim();
            String numericPart = raw;
            String inlineUnit = null;
            java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("^([0-9]+(?:\\.[0-9]+)?)\\s*([a-zA-Z]+)?$").matcher(raw);
            if (m.matches()) {
                numericPart = m.group(1);
                if (m.group(2) != null && !m.group(2).isBlank()) inlineUnit = m.group(2);
            }
            BigDecimal n = new BigDecimal(numericPart);
            String u = inlineUnit != null
                ? inlineUnit.trim().toLowerCase()
                : (setting.unit() != null ? setting.unit().trim().toLowerCase() : "kb");
            BigDecimal multiplier = switch (u) {
                case "b", "byte", "bytes" -> BigDecimal.ONE;
                case "kb" -> new BigDecimal(1024);
                case "8kb" -> new BigDecimal(8192);
                case "mb" -> new BigDecimal(1_048_576);
                case "gb" -> new BigDecimal(1_073_741_824);
                default -> new BigDecimal(1024);
            };
            return n.multiply(multiplier).longValue();
        } catch (Exception e) {
            return fallbackBytes;
        }
    }

    private static long roundWorkMemBytes(long bytes, boolean roundUp) {
        long mb = Math.max(1, bytes / 1_048_576L);
        long[] steps = {1, 2, 4, 8, 16, 32, 64, 128, 256, 512};
        long selected = steps[0];
        for (long step : steps) {
            if (roundUp) {
                if (mb <= step) return step * 1_048_576L;
            } else if (mb >= step) {
                selected = step;
            }
        }
        return selected * 1_048_576L;
    }

    private static String humanWorkMem(long bytes) {
        if (bytes >= 1_073_741_824L && bytes % 1_073_741_824L == 0) {
            return (bytes / 1_073_741_824L) + "GB";
        }
        if (bytes >= 1_048_576L && bytes % 1_048_576L == 0) {
            return (bytes / 1_048_576L) + "MB";
        }
        return Math.max(1, bytes / 1024L) + "kB";
    }

    private static String humanBytes(long bytes) {
        if (bytes >= 1_073_741_824) return String.format("%.1f GB", bytes / 1_073_741_824.0);
        if (bytes >= 1_048_576) return String.format("%.1f MB", bytes / 1_048_576.0);
        if (bytes >= 1_024) return String.format("%.1f KB", bytes / 1_024.0);
        return bytes + " B";
    }

    private static String humanMs(long ms) {
        if (ms >= 3_600_000) return String.format("%.1f saat", ms / 3_600_000.0);
        if (ms >= 60_000) return String.format("%.1f dk", ms / 60_000.0);
        if (ms >= 1_000) return String.format("%.1f sn", ms / 1_000.0);
        return ms + " ms";
    }

    private static long toLong(Object val) {
        if (val == null) return 0;
        return ((Number) val).longValue();
    }

    private static BigDecimal toBD(Object val) {
        if (val == null) return BigDecimal.ZERO;
        if (val instanceof BigDecimal bd) return bd;
        if (val instanceof Number n) return BigDecimal.valueOf(n.doubleValue());
        return new BigDecimal(val.toString());
    }
}
