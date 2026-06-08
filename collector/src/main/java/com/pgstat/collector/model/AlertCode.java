package com.pgstat.collector.model;

/**
 * Supported alert codes.
 * ops.alert alert_code values are mapped from this enum.
 */
public enum AlertCode {

    SYSTEM_STAT_COLLECTION_FAILED("system_stat_collection_failed", "error", "system"),
    SYSTEM_PARTITION_MISSING("system_partition_missing", "critical", "system"),
    SYSTEM_INSTANCE_UNREACHABLE("system_instance_unreachable", "critical", "system"),
    SYSTEM_COLLECTOR_STALE("system_collector_stale", "warning", "system"),
    SYSTEM_CLEANUP_FAILED("system_cleanup_failed", "error", "system"),
    SYSTEM_DISK_FULL("system_disk_full", "critical", "system"),

    SLOT_LOST("slot_lost", "critical", "adaptive"),
    SLOT_ACTIVE_DELETED("slot_active_deleted", "critical", "adaptive"),
    SLOT_INACTIVE_DELETED("slot_inactive_deleted", "info", "adaptive"),
    SLOT_INACTIVE_LONG("slot_inactive_long", "warning", "adaptive"),
    SLOT_RECREATED("slot_recreated", "info", "adaptive"),

    USER_DEFINED_RULE("user_defined_rule", "warning", "rule");

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
