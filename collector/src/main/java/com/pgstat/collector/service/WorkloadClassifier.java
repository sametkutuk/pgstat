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

    /** Kısa vade (24h) — saatte 1, anlık karakter. Startup'tan 1 dk sonra ilk run. */
    @Scheduled(fixedDelay = 3_600_000, initialDelay = 60_000)
    public void classifyShortTerm() {
        Map<String, Object> cfg = loadConfig();
        int windowHours = ((Number) cfg.get("window_hours")).intValue();
        runClassification(cfg, windowHours, false);
    }

    /** Uzun vade (90g) — 24 saatte 1, gerçek karakter (yön değişmez). */
    @Scheduled(fixedDelay = 86_400_000, initialDelay = 5 * 60_000)
    public void classifyLongTerm() {
        Map<String, Object> cfg = loadConfig();
        int days = 90;
        Object v = cfg.get("long_window_days");
        if (v instanceof Number n) days = n.intValue();
        runClassification(cfg, days * 24, true);
    }

    /** Eski API uyumluluğu (varsa external çağrı için). */
    public void classifyAll() {
        classifyShortTerm();
    }

    private void runClassification(Map<String, Object> cfg, int windowHours, boolean longTerm) {
        try {
            String tag = longTerm ? "uzun-vade" : "kısa-vade";
            // Idle eşiği pencere genişliğine orantılı olarak ölçeklenir.
            // 24h pencerede 100 calls eşiği uygun; 90g pencerede aynı eşik anlamsız (her DB aktif).
            BigDecimal idleMaxCalls = new BigDecimal(cfg.get("idle_max_calls").toString())
                .multiply(BigDecimal.valueOf(Math.max(1, windowHours / 24.0)));
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
                int oltp, analytical, bulk;
                if (calls.compareTo(idleMaxCalls) < 0) {
                    label = "idle";
                    oltp = analytical = bulk = 0;
                } else {
                    // Gradient skor formülü — her metrik 0..1 arası skor üretir,
                    // toplam normalize edilir. Eşikler "tipik referans değer";
                    // metrik referansa eşitse 50, daha yüksekse 100'e doğru artar.
                    double tpsRef = oltpMinTps.doubleValue() * 50.0;          // örn. 1.0 * 50 = 50 tps
                    double avgMsRef = oltpMaxAvgMs.doubleValue();             // örn. 50ms
                    double analyticMsRef = analyticMinAvgMs.doubleValue();    // örn. 500ms
                    double analyticRowsRef = analyticMinRows.doubleValue();   // örn. 5000
                    double bulkRowsRef = bulkMinRowsWrite.doubleValue();      // örn. 50000

                    // OLTP: yüksek tps + düşük avg_ms (her ikisi de iyi olmalı)
                    double oltpTps = Math.min(tps.doubleValue() / Math.max(tpsRef, 1.0), 1.0);
                    double oltpMs = 1.0 / (1.0 + (avgMs.doubleValue() / Math.max(avgMsRef, 1.0)));
                    double oltpScore = oltpTps * oltpMs;

                    // Analytical: avg_ms VE rows/call yüksek (max alıyoruz, biri yetsin)
                    double analyticMs = Math.min(avgMs.doubleValue() / Math.max(analyticMsRef, 1.0), 1.0);
                    double analyticRows = Math.min(rowsPerCall.doubleValue() / Math.max(analyticRowsRef, 1.0), 1.0);
                    double analyticalScore = Math.max(analyticMs, analyticRows);

                    // Bulk: rows/call çok yüksek (analytical'dan ayrışmak için 4x referans)
                    double bulkScore = Math.min(rowsPerCall.doubleValue() / (bulkRowsRef * 4.0), 1.0);
                    if (rowsPerCall.doubleValue() < bulkRowsRef) bulkScore = 0; // bulk için min eşik şart

                    oltp = (int) Math.round(oltpScore * 100);
                    analytical = (int) Math.round(analyticalScore * 100);
                    bulk = (int) Math.round(bulkScore * 100);

                    int total = oltp + analytical + bulk;
                    if (total == 0) {
                        // Aktivite var ama hiçbir sınıfa yerleşmedi → düşük yoğunluklu OLTP
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

                if (longTerm) {
                    jdbc.update("""
                        update dim.database_ref
                           set workload_label_long = ?,
                               workload_scores_long = ?::jsonb,
                               workload_classified_long_at = now()
                         where instance_pk = ? and dbid = ?
                        """, label, scoresJson, instancePk, dbid);
                } else {
                    jdbc.update("""
                        update dim.database_ref
                           set workload_label_auto = ?,
                               workload_scores = ?::jsonb,
                               workload_classified_at = now()
                         where instance_pk = ? and dbid = ?
                        """, label, scoresJson, instancePk, dbid);
                }
                classified++;
            }
            log.info("Workload classification ({}): {} DB sınıflandırıldı", tag, classified);
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
