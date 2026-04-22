package com.pgstat.collector.model;

/**
 * Desteklenen alert kodlari.
 * ops.alert tablosundaki alert_code degerlerine karsilik gelir.
 */
public enum AlertCode {

    // Instance seviyesi
    CONNECTION_FAILURE("connection_failure", "critical", "instance"),
    AUTHENTICATION_FAILURE("authentication_failure", "critical", "instance"),
    PERMISSION_DENIED("permission_denied", "error", "instance"),
    EXTENSION_MISSING("extension_missing", "warning", "instance"),
    HIGH_CONNECTION_USAGE("high_connection_usage", "warning", "instance"),
    LONG_RUNNING_QUERY("long_running_query", "warning", "instance"),
    REPLICATION_LAG("replication_lag", "warning", "instance"),
    HIGH_BLOAT_RATIO("high_bloat_ratio", "info", "instance"),
    STALE_DATA("stale_data", "warning", "instance"),
    STATS_RESET_DETECTED("stats_reset_detected", "info", "instance"),
    BOOTSTRAP_FAILED("bootstrap_failed", "error", "instance"),
    SECRET_REF_ERROR("secret_ref_error", "critical", "instance"),
    LOCK_CONTENTION("lock_contention", "warning", "instance"),

    // Job seviyesi
    JOB_PARTIAL_FAILURE("job_partial_failure", "warning", "job"),
    JOB_FAILED("job_failed", "error", "job"),
    ADVISORY_LOCK_SKIP("advisory_lock_skip", "info", "job");

    private final String code;
    private final String defaultSeverity;
    private final String sourceComponent;

    AlertCode(String code, String defaultSeverity, String sourceComponent) {
        this.code = code;
        this.defaultSeverity = defaultSeverity;
        this.sourceComponent = sourceComponent;
    }

    public String getCode() {
        return code;
    }

    public String getDefaultSeverity() {
        return defaultSeverity;
    }

    public String getSourceComponent() {
        return sourceComponent;
    }
}
