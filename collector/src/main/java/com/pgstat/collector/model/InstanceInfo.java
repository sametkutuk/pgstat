package com.pgstat.collector.model;

import java.time.OffsetDateTime;

/**
 * Scheduler sorgularindan donen instance bilgisi.
 * instance_inventory + instance_state + schedule_profile join sonucu.
 */
public record InstanceInfo(
    long instancePk,
    String instanceId,
    String host,
    int port,
    String adminDbname,
    String secretRef,
    String sslMode,
    String bootstrapState,
    String collectorUsername,
    // schedule_profile degerleri
    int connectTimeoutSeconds,
    int statementTimeoutMs,
    int lockTimeoutMs,
    int bootstrapSqlTextBatch,
    // instance_state degerleri (null olabilir — bootstrap oncesi)
    OffsetDateTime nextClusterCollectAt,
    OffsetDateTime nextStatementsCollectAt
) {}
