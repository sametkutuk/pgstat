package com.pgstat.collector.service;

import com.pgstat.collector.model.AlertCode;
import com.pgstat.collector.repository.AlertRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Map;

/**
 * 5 aksiyon-odakli alert evaluator.
 * UTC 04:00'te JobOrchestrator tarafindan gunde 1 kez tetiklenir.
 * Gece snapshot (03:00) + runtime fact tablolarindan veri okur.
 *
 * Alert'ler:
 * 1. INDEX_SUSPECT_MISSING — seq_scan/idx_scan > 100, tablo > 10MB
 * 2. INDEX_UNUSED — 30g idx_scan=0, index > 100MB
 * 3. HIGH_TEMP_FILES — temp_files > 100/saat
 * 4. IDLE_IN_TX_TIME_HIGH — idle_in_tx / session > 30% (PG14+)
 * 5. REPLICATION_SLOT_INACTIVE — 1h inactive, lag > 1GB
 *
 * Her alert somut SQL aksiyon onerisi icerir (V040 template'leri).
 */
@Service
public class ActionableAlertEvaluator {

    private static final Logger log = LoggerFactory.getLogger(ActionableAlertEvaluator.class);

    private final JdbcTemplate jdbc;
    private final AlertRepository alertRepo;
    private final AlertMessageRenderer renderer;

    public ActionableAlertEvaluator(JdbcTemplate jdbc, AlertRepository alertRepo,
                                     AlertMessageRenderer renderer) {
        this.jdbc = jdbc;
        this.alertRepo = alertRepo;
        this.renderer = renderer;
    }

    /** Tum 5 alert'i degerlendir. Hata olursa diger alert'lere devam et. */
    public void evaluateAll() {
        log.info("Aksiyon-odakli alert degerlendirmesi basliyor (gunluk)...");
        int total = 0;
        total += safeEval("INDEX_SUSPECT_MISSING", this::checkIndexSuspectMissing);
        total += safeEval("INDEX_UNUSED", this::checkIndexUnused);
        log.info("Gunluk aksiyon-odakli alert degerlendirmesi tamamlandi: {} alert", total);
    }

    /**
     * Anlik sorunlar icin her rollup cycle'da (5 saniyede bir) calisir.
     * HIGH_TEMP_FILES, IDLE_IN_TX_TIME_HIGH, REPLICATION_SLOT_INACTIVE
     * — bunlar acil mudahale gerektiren durumlar, gunde 1 kez bakmak gec kalir.
     */
    public void evaluateFrequent() {
        int total = 0;
        total += safeEval("HIGH_TEMP_FILES", this::checkHighTempFiles);
        total += safeEval("IDLE_IN_TX_TIME_HIGH", this::checkIdleInTxTimeHigh);
        total += safeEval("REPLICATION_SLOT_INACTIVE", this::checkReplicationSlotInactive);
        if (total > 0) {
            log.info("Anlik aksiyon-odakli alert: {} yeni tetiklendi", total);
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
        List<Map<String, Object>> rows = jdbc.queryForList("""
            with t as (
              select t.instance_pk, t.dbid, t.schemaname, t.relname,
                     sum(t.seq_scan_delta) as seq_scans,
                     sum(t.idx_scan_delta) as idx_scans,
                     sum(t.seq_tup_read_delta) as seq_tup_read
              from fact.pg_table_stat_delta t
              where t.sample_ts > now() - interval '24 hours'
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
              and (s.idx_scans = 0 or s.ratio > 100)
              and s.seq_tup_read > 100000
              and s.total_size_bytes > 10485760
            order by s.seq_tup_read desc
            limit 20
            """);

        int count = 0;
        for (Map<String, Object> r : rows) {
            String alertKey = "actionable:index_suspect_missing:" +
                r.get("instance_pk") + ":" + r.get("dbid") + ":" +
                r.get("schemaname") + "." + r.get("relname");

            Map<String, Object> ctx = Map.of(
                "instance", r.get("display_name"),
                "instance_pk", r.get("instance_pk"),
                "database", r.get("datname") != null ? r.get("datname") : "?",
                "table", r.get("schemaname") + "." + r.get("relname"),
                "relname", r.get("relname"),
                "table_size_human", humanBytes(toLong(r.get("total_size_bytes"))),
                "seq_scans", r.get("seq_scans"),
                "idx_scans", r.get("idx_scans"),
                "seq_idx_ratio", r.get("ratio"),
                "seq_tup_read", r.get("seq_tup_read")
            );

            String[] rendered = renderer.renderForCode("index_suspect_missing", ctx,
                "Index gerekiyor: " + r.get("schemaname") + "." + r.get("relname"),
                "seq_scan/idx_scan oranı çok yüksek");

            alertRepo.upsert(alertKey, AlertCode.INDEX_SUSPECT_MISSING,
                toLong(r.get("instance_pk")), null, null,
                rendered[0], rendered[1], null);
            count++;
        }
        return count;
    }

    // =========================================================================
    // 2. INDEX_UNUSED — 30g idx_scan=0, index > 100MB
    // =========================================================================

    private int checkIndexUnused() {
        List<Map<String, Object>> rows = jdbc.queryForList("""
            with idx as (
              select i.instance_pk, i.dbid, i.schemaname, i.indexrelname, i.table_relname,
                     sum(i.idx_scan_delta) as total_scans
              from fact.pg_index_stat_delta i
              where i.sample_ts > now() - interval '30 days'
              group by i.instance_pk, i.dbid, i.schemaname, i.indexrelname, i.table_relname
            )
            select idx.*, rs.total_size_bytes, inst.display_name, dbr.datname
            from idx
            left join lateral (
              select total_size_bytes from fact.pg_relation_size_snapshot rs
              where rs.instance_pk = idx.instance_pk and rs.dbid = idx.dbid
                and rs.schemaname = idx.schemaname and rs.relname = idx.indexrelname
                and rs.relkind = 'i'
              order by snapshot_ts desc limit 1
            ) rs on true
            join control.instance_inventory inst on inst.instance_pk = idx.instance_pk
            left join dim.database_ref dbr on dbr.instance_pk = idx.instance_pk and dbr.dbid = idx.dbid
            where idx.total_scans = 0
              and coalesce(rs.total_size_bytes, 0) > 104857600
            order by rs.total_size_bytes desc nulls last
            limit 20
            """);

        int count = 0;
        for (Map<String, Object> r : rows) {
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
                "30 gündür idx_scan = 0");

            alertRepo.upsert(alertKey, AlertCode.INDEX_UNUSED,
                toLong(r.get("instance_pk")), null, null,
                rendered[0], rendered[1], null);
            count++;
        }
        return count;
    }

    // =========================================================================
    // 3. HIGH_TEMP_FILES — temp_files > 100/saat
    // =========================================================================

    private int checkHighTempFiles() {
        List<Map<String, Object>> rows = jdbc.queryForList("""
            select d.instance_pk, d.dbid, d.datname,
                   sum(d.temp_files_delta) as temp_files,
                   sum(d.temp_bytes_delta) as temp_bytes,
                   i.display_name
            from fact.pg_database_delta d
            join control.instance_inventory i on i.instance_pk = d.instance_pk
            where d.sample_ts > now() - interval '1 hour'
            group by d.instance_pk, d.dbid, d.datname, i.display_name
            having sum(d.temp_files_delta) > 100
            """);

        int count = 0;
        for (Map<String, Object> r : rows) {
            long instancePk = toLong(r.get("instance_pk"));
            String alertKey = "actionable:high_temp_files:" + instancePk + ":" + r.get("dbid");

            // work_mem degerini snapshot'tan oku
            String workMem = "?";
            try {
                workMem = jdbc.queryForObject(
                    "select setting_value from fact.pg_settings_snapshot " +
                    "where instance_pk = ? and setting_name = 'work_mem' " +
                    "order by snapshot_ts desc limit 1",
                    String.class, instancePk);
            } catch (Exception ignore) {}

            // Top 3 temp ureten sorgu
            String topQueries = buildTopTempQueries(instancePk);

            // Onerilen work_mem hesabi (basit: max temp_bytes / 1M, en yakin guzel deger)
            long tempBytes = toLong(r.get("temp_bytes"));
            String suggested = suggestWorkMem(tempBytes);

            Map<String, Object> ctx = new java.util.HashMap<>();
            ctx.put("instance", r.get("display_name"));
            ctx.put("instance_pk", instancePk);
            ctx.put("database", r.get("datname"));
            ctx.put("temp_files", r.get("temp_files"));
            ctx.put("temp_bytes_human", humanBytes(tempBytes));
            ctx.put("work_mem", workMem);
            ctx.put("top_temp_queries", topQueries);
            ctx.put("suggested_work_mem", suggested);

            String[] rendered = renderer.renderForCode("high_temp_files", ctx,
                "Yüksek temp file: " + r.get("datname"),
                "temp_files > 100/saat, work_mem=" + workMem);

            alertRepo.upsert(alertKey, AlertCode.HIGH_TEMP_FILES,
                instancePk, null, null, rendered[0], rendered[1], null);
            count++;
        }
        return count;
    }

    // =========================================================================
    // 4. IDLE_IN_TX_TIME_HIGH — idle_in_tx / session > 30% (PG14+)
    // =========================================================================

    private int checkIdleInTxTimeHigh() {
        // idle_in_transaction_time_ms_delta kolonu PG14+ icin var
        // Kolon yoksa sorgu hata verir → graceful skip (safeEval yakalar)
        List<Map<String, Object>> rows = jdbc.queryForList("""
            select d.instance_pk, d.dbid, d.datname,
                   sum(d.idle_in_transaction_time_ms_delta) as idle_ms,
                   sum(d.session_time_ms_delta) as session_ms,
                   round(100.0 * sum(d.idle_in_transaction_time_ms_delta)::numeric /
                         nullif(sum(d.session_time_ms_delta), 0), 1) as idle_pct,
                   i.display_name
            from fact.pg_database_delta d
            join control.instance_inventory i on i.instance_pk = d.instance_pk
            where d.sample_ts > now() - interval '1 hour'
            group by d.instance_pk, d.dbid, d.datname, i.display_name
            having sum(d.session_time_ms_delta) > 60000
               and (sum(d.idle_in_transaction_time_ms_delta)::numeric /
                    nullif(sum(d.session_time_ms_delta), 0)) > 0.3
            """);

        int count = 0;
        for (Map<String, Object> r : rows) {
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

            alertRepo.upsert(alertKey, AlertCode.IDLE_IN_TX_TIME_HIGH,
                toLong(r.get("instance_pk")), null, null,
                rendered[0], rendered[1], null);
            count++;
        }
        return count;
    }

    // =========================================================================
    // 5. REPLICATION_SLOT_INACTIVE — 1h inactive, lag > 1GB
    // =========================================================================

    private int checkReplicationSlotInactive() {
        List<Map<String, Object>> rows = jdbc.queryForList("""
            with latest as (
              select instance_pk, slot_name, max(sample_ts) as ts
              from fact.pg_replication_slot_snapshot
              where sample_ts > now() - interval '1 hour'
              group by instance_pk, slot_name
            )
            select s.instance_pk, s.slot_name, s.slot_type, s.wal_status, s.slot_lag_bytes,
                   i.display_name
            from fact.pg_replication_slot_snapshot s
            join latest l on l.instance_pk = s.instance_pk and l.slot_name = s.slot_name and l.ts = s.sample_ts
            join control.instance_inventory i on i.instance_pk = s.instance_pk
            where s.active = false
              and s.slot_lag_bytes > 1073741824
              and not exists (
                select 1 from fact.pg_replication_slot_snapshot s2
                where s2.instance_pk = s.instance_pk and s2.slot_name = s.slot_name
                  and s2.sample_ts > now() - interval '1 hour'
                  and s2.active = true
              )
            """);

        int count = 0;
        for (Map<String, Object> r : rows) {
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

            alertRepo.upsert(alertKey, AlertCode.REPLICATION_SLOT_INACTIVE,
                toLong(r.get("instance_pk")), null, null,
                rendered[0], rendered[1], null);
            count++;
        }
        return count;
    }

    // =========================================================================
    // Yardimci
    // =========================================================================

    private String buildTopTempQueries(long instancePk) {
        try {
            List<Map<String, Object>> rows = jdbc.queryForList("""
                select left(qt.query_text, 80) as query,
                       sum(d.temp_blks_written_delta) * 8192 as bytes
                from fact.pgss_delta d
                join dim.statement_series ss on ss.statement_series_id = d.statement_series_id
                left join dim.query_text qt on qt.query_text_id = ss.query_text_id
                where d.instance_pk = ? and d.sample_ts > now() - interval '1 hour'
                  and d.temp_blks_written_delta > 0
                group by qt.query_text
                order by bytes desc limit 3
                """, instancePk);

            if (rows.isEmpty()) return "(veri yok)";
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < rows.size(); i++) {
                if (i > 0) sb.append("\n");
                sb.append(i + 1).append(". `").append(rows.get(i).get("query"))
                  .append("` → ").append(humanBytes(toLong(rows.get(i).get("bytes"))));
            }
            return sb.toString();
        } catch (Exception e) {
            return "(hesaplanamadı)";
        }
    }

    /** Onerilen work_mem: temp_bytes'a gore en yakin guzel deger */
    private String suggestWorkMem(long tempBytes) {
        // En buyuk temp islem icin yeterli olacak deger
        long mb = Math.max(16, tempBytes / 1048576 / 10); // kaba tahmin
        if (mb <= 16) return "16MB";
        if (mb <= 32) return "32MB";
        if (mb <= 64) return "64MB";
        if (mb <= 128) return "128MB";
        if (mb <= 256) return "256MB";
        return "512MB";
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
}
