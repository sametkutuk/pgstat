package com.pgstat.collector.model;

import java.time.OffsetDateTime;

/**
 * Per-database toplama durumu — control.database_state satirinin Java karsiligi.
 */
public record DatabaseState(
    long instancePk,
    long dbid,
    OffsetDateTime lastDbObjectsCollectAt,
    OffsetDateTime nextDbObjectsCollectAt,
    int consecutiveFailures,
    OffsetDateTime backoffUntil
) {}
