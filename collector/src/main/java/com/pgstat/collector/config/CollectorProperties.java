package com.pgstat.collector.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Collector ozel yapilandirma degerleri.
 * application.yml icerisindeki pgstat.worker.* prefix'ine baglanir.
 *
 * Ornek:
 *   pgstat:
 *     worker:
 *       hostname: collector-01
 *       poll-interval-ms: 5000
 *       max-concurrent-hosts: 5
 */
@ConfigurationProperties(prefix = "pgstat.worker")
public class CollectorProperties {

    /** Bu collector instance'inin hostname'i — job_run tablosuna yazilir */
    private String hostname = "collector-01";

    /** Scheduler poll araligi (ms) — her N ms'de DB'den due instance kontrol eder */
    private long pollIntervalMs = 5000;

    /** Ayni anda paralel islenebilecek maksimum host sayisi */
    private int maxConcurrentHosts = 5;

    /** Bootstrap queue'dan her seferde alinacak instance sayisi */
    private int bootstrapBatchSize = 10;

    /** Steady-state queue'dan her seferde alinacak instance sayisi */
    private int schedulerBatchSize = 20;

    // --- Getter / Setter ---

    public String getHostname() {
        return hostname;
    }

    public void setHostname(String hostname) {
        this.hostname = hostname;
    }

    public long getPollIntervalMs() {
        return pollIntervalMs;
    }

    public void setPollIntervalMs(long pollIntervalMs) {
        this.pollIntervalMs = pollIntervalMs;
    }

    public int getMaxConcurrentHosts() {
        return maxConcurrentHosts;
    }

    public void setMaxConcurrentHosts(int maxConcurrentHosts) {
        this.maxConcurrentHosts = maxConcurrentHosts;
    }

    public int getBootstrapBatchSize() {
        return bootstrapBatchSize;
    }

    public void setBootstrapBatchSize(int bootstrapBatchSize) {
        this.bootstrapBatchSize = bootstrapBatchSize;
    }

    public int getSchedulerBatchSize() {
        return schedulerBatchSize;
    }

    public void setSchedulerBatchSize(int schedulerBatchSize) {
        this.schedulerBatchSize = schedulerBatchSize;
    }
}
