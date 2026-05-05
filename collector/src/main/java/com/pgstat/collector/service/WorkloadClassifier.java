package com.pgstat.collector.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;

/**
 * Her DB için 24h pencerede workload sınıflandırması yapar.
 * Skorlar 0-100, normalize edilir, baskın etiket dim.database_ref.workload_label_auto'ya yazılır.
 *
 * Sınıflar: oltp, analytical, bulk, mixed, idle
 *
 * Çalışma frekansı: saatte 1 kere — workload profili saatte değişmez, gereksiz CPU.
 */
@Service
public class WorkloadClassifier {

    private static final Logger log = LoggerFactory.getLogger(WorkloadClassifier.class);

    private final JdbcTemplate jdbc;

    public WorkloadClassifier(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Saatte 1 kere — fixedDelay 1h. Startup'tan 1 dakika sonra ilk run. */
    @Scheduled(fixedDelay = 3_600_000, initialDelay = 60_000)
    public void classifyAll() {
        try {
            Map<String, Object> cfg = loadConfig();
            int windowHours = ((Number) cfg.get("window_hours")).intValue();
            BigDecimal idleMaxCalls = new BigDecimal(cfg.get("idle_max_calls").toString());
            BigDecimal oltpMinTps = (BigDecimal) cfg.get("oltp_min_tps");
            BigDecimal oltpMaxAvgMs = (BigDecimal) cfg.get("oltp_max_avg_ms");
            BigDecimal analyticMinAvgMs = (BigDecimal) cfg.get("analytic_min_avg_ms");
            BigDecimal analyticMinRows = (BigDecimal) cfg.get("analytic_min_rows");
            BigDecimal bulkMinRowsWrite = (BigDecimal) cfg.get("bulk_min_rows_write");
            BigDecimal mixedMaxDominant = (BigDecimal) cfg.get("mixed_max_dominant");

            // Tüm aktif DB'ler için pgss_delta agregasyonu (24h pencere)
            List<Map<String, Object>> rows = jdbc.queryForList("""
                with stats as (
                  select ss.instance_pk, ss.dbid,
                         sum(d.calls_delta) as calls,
                         avg(case when d.calls_delta > 0
                             then d.total_exec_time_ms_delta::numeric / d.calls_delta
                             else null end) as avg_ms,
                         sum(d.rows_delta)::numeric / nullif(sum(d.calls_delta),0) as rows_per_call,
                         (sum(d.rows_delta) - coalesce(sum(d.shared_blks_hit_delta * 0),0))::numeric
                            / nullif(sum(d.calls_delta),0) as write_per_call,
                         sum(d.calls_delta)::numeric /
                            nullif(extract(epoch from interval '%d hours'),0) as tps,
                         sum(coalesce(d.temp_blks_written_delta,0)) as temp_blocks
                  from fact.pgss_delta d
                  join dim.statement_series ss on ss.statement_series_id = d.statement_series_id
                  where d.sample_ts > now() - make_interval(hours => ?)
                  group by ss.instance_pk, ss.dbid
                )
                select s.instance_pk, s.dbid, dbr.datname,
                       coalesce(s.calls, 0) as calls,
                       coalesce(s.avg_ms, 0) as avg_ms,
                       coalesce(s.rows_per_call, 0) as rows_per_call,
                       coalesce(s.tps, 0) as tps,
                       coalesce(s.temp_blocks, 0) as temp_blocks
                from dim.database_ref dbr
                left join stats s on s.instance_pk = dbr.instance_pk and s.dbid = dbr.dbid
                """.formatted(windowHours), windowHours);

            int classified = 0;
            for (Map<String, Object> r : rows) {
                long instancePk = ((Number) r.get("instance_pk")).longValue();
                long dbid = ((Number) r.get("dbid")).longValue();
                BigDecimal calls = toBig(r.get("calls"));
                BigDecimal avgMs = toBig(r.get("avg_ms"));
                BigDecimal rowsPerCall = toBig(r.get("rows_per_call"));
                BigDecimal tps = toBig(r.get("tps"));

                // Idle kontrol
                String label;
                int oltp = 0, analytical = 0, bulk = 0;
                if (calls.compareTo(idleMaxCalls) < 0) {
                    label = "idle";
                } else {
                    // OLTP skor: yüksek tps + düşük avg_ms
                    if (tps.compareTo(oltpMinTps) > 0 && avgMs.compareTo(oltpMaxAvgMs) < 0) {
                        // Min(tps/100, 1) * (1 - avg_ms/oltp_max_avg_ms) * 100
                        double tpsScore = Math.min(tps.doubleValue() / 100.0, 1.0);
                        double msScore = 1.0 - Math.min(avgMs.doubleValue() / oltpMaxAvgMs.doubleValue(), 1.0);
                        oltp = (int) Math.round(tpsScore * msScore * 100);
                    }
                    // Analytical skor: yüksek avg_ms + yüksek rows/call
                    if (avgMs.compareTo(analyticMinAvgMs) > 0 || rowsPerCall.compareTo(analyticMinRows) > 0) {
                        double msScore = Math.min(avgMs.doubleValue() / 5000.0, 1.0);
                        double rowsScore = Math.min(rowsPerCall.doubleValue() / 50000.0, 1.0);
                        analytical = (int) Math.round(Math.max(msScore, rowsScore) * 100);
                    }
                    // Bulk skor: write/call yüksek (rows_per_call büyük + write işlem)
                    if (rowsPerCall.compareTo(bulkMinRowsWrite) > 0) {
                        bulk = (int) Math.round(Math.min(rowsPerCall.doubleValue() / 200000.0, 1.0) * 100);
                    }

                    int total = oltp + analytical + bulk;
                    if (total == 0) {
                        // Aktivite var ama hiçbir sınıfa yerleşmedi → düşük yoğunluklu OLTP varsay
                        label = "oltp";
                        oltp = 100;
                    } else {
                        // Normalize
                        int oltpPct = oltp * 100 / total;
                        int analyticalPct = analytical * 100 / total;
                        int bulkPct = bulk * 100 / total;
                        oltp = oltpPct;
                        analytical = analyticalPct;
                        bulk = bulkPct;

                        int max = Math.max(oltp, Math.max(analytical, bulk));
                        if (max < mixedMaxDominant.intValue()) {
                            label = "mixed";
                        } else if (max == oltp) {
                            label = "oltp";
                        } else if (max == analytical) {
                            label = "analytical";
                        } else {
                            label = "bulk";
                        }
                    }
                }

                String scoresJson = String.format(
                    "{\"oltp\":%d,\"analytical\":%d,\"bulk\":%d}",
                    oltp, analytical, bulk);

                jdbc.update("""
                    update dim.database_ref
                       set workload_label_auto = ?,
                           workload_scores = ?::jsonb,
                           workload_classified_at = now()
                     where instance_pk = ? and dbid = ?
                    """, label, scoresJson, instancePk, dbid);
                classified++;
            }
            log.info("Workload classification: {} DB sınıflandırıldı", classified);
        } catch (Exception e) {
            log.warn("Workload classification hatası: {}", e.getMessage());
        }
    }

    private Map<String, Object> loadConfig() {
        try {
            return jdbc.queryForMap(
                "select * from control.workload_classification_config where config_id = 1");
        } catch (Exception e) {
            return Map.of(
                "window_hours", 24,
                "idle_max_calls", new BigDecimal("100"),
                "oltp_min_tps", new BigDecimal("1.0"),
                "oltp_max_avg_ms", new BigDecimal("50"),
                "analytic_min_avg_ms", new BigDecimal("500"),
                "analytic_min_rows", new BigDecimal("5000"),
                "bulk_min_rows_write", new BigDecimal("50000"),
                "mixed_max_dominant", new BigDecimal("50")
            );
        }
    }

    private static BigDecimal toBig(Object val) {
        if (val == null) return BigDecimal.ZERO;
        if (val instanceof BigDecimal b) return b;
        if (val instanceof Number n) return BigDecimal.valueOf(n.doubleValue());
        return BigDecimal.ZERO;
    }
}
