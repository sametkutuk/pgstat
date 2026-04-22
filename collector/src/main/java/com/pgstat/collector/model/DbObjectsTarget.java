package com.pgstat.collector.model;

/**
 * db_objects job'i icin due database bilgisi.
 * Scheduler sorgusundan donen instance + database cifti.
 */
public record DbObjectsTarget(
    long instancePk,
    String instanceId,
    String host,
    int port,
    long dbid,
    String datname,
    String secretRef,
    String sslMode,
    String collectorUsername,
    int dbObjectsIntervalSeconds,
    int statementTimeoutMs,
    int lockTimeoutMs,
    int connectTimeoutSeconds
) {}
