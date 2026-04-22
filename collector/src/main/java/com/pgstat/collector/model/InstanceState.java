package com.pgstat.collector.model;

import java.time.OffsetDateTime;

/**
 * Runtime toplama durumu — control.instance_state satirinin Java karsiligi.
 */
public record InstanceState(
    long instancePk,
    OffsetDateTime lastClusterCollectAt,
    OffsetDateTime lastStatementsCollectAt,
    OffsetDateTime lastRollupAt,
    OffsetDateTime nextClusterCollectAt,
    OffsetDateTime nextStatementsCollectAt,
    OffsetDateTime bootstrapCompletedAt,
    String currentPgssEpochKey,
    OffsetDateTime lastClusterStatsResetAt,
    int consecutiveFailures,
    OffsetDateTime backoffUntil,
    OffsetDateTime lastSuccessAt
) {}
