package com.pgstat.collector.model;

import java.time.OffsetDateTime;

/**
 * Kaynak PostgreSQL instance'inin yetenekleri.
 * Discovery adimindan sonra control.instance_capability tablosuna yazilir.
 */
public record InstanceCapability(
    long instancePk,
    int serverVersionNum,
    int pgMajor,
    long systemIdentifier,
    boolean isReachable,
    boolean isPrimary,
    boolean hasPgStatStatements,
    boolean hasPgStatStatementsInfo,
    boolean hasPgStatIo,
    boolean hasPgStatCheckpointer,
    String computeQueryIdMode,
    String collectorSqlFamily,
    OffsetDateTime lastPostmasterStartAt,
    OffsetDateTime lastPgssStatsResetAt,
    OffsetDateTime lastDiscoveredAt,
    OffsetDateTime lastErrorAt,
    String lastErrorText
) {}
