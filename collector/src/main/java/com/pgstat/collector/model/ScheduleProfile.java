package com.pgstat.collector.model;

/**
 * Toplama profili — control.schedule_profile satirinin Java karsiligi.
 * Intervaller, timeout'lar ve batch limitleri burada tutulur.
 */
public record ScheduleProfile(
    long scheduleProfileId,
    String profileCode,
    int clusterIntervalSeconds,
    int statementsIntervalSeconds,
    int dbObjectsIntervalSeconds,
    int hourlyRollupIntervalSeconds,
    int dailyRollupHourUtc,
    int bootstrapSqlTextBatch,
    int maxDatabasesPerRun,
    int statementTimeoutMs,
    int lockTimeoutMs,
    int connectTimeoutSeconds,
    int maxHostConcurrency,
    boolean isActive
) {}
