package com.pgstat.collector.model;

import java.util.Map;

/**
 * Kaynak PG'den okunan cluster metrikleri kumulatif sample'i.
 * Delta hesaplamasi icin onceki sample ile karsilastirilir.
 *
 * metrics map yapisi: "metricFamily.metricName" → kumulatif deger
 * Ornek: "pg_stat_bgwriter.buffers_clean" → 12345
 */
public record ClusterMetricSample(
    long instancePk,
    Map<String, Double> metrics
) {
    /** Belirli bir metrigin kumulatif degerini okur (yoksa null). */
    public Double get(String family, String name) {
        return metrics.get(family + "." + name);
    }
}
