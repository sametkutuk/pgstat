package com.pgstat.collector.model;

/**
 * pg_stat_statements'tan okunan tek bir satirin kumulatif degerleri.
 * Delta hesaplamasi icin onceki sample ile karsilastirilir.
 */
public record StatementSample(
    long userid,
    long dbid,
    long queryid,
    Boolean toplevel,
    long calls,
    long plans,
    double totalPlanTime,
    double totalExecTime,
    long rows,
    long sharedBlksHit,
    long sharedBlksRead,
    long sharedBlksDirtied,
    long sharedBlksWritten,
    long localBlksHit,
    long localBlksRead,
    long localBlksDirtied,
    long localBlksWritten,
    long tempBlksRead,
    long tempBlksWritten,
    double blkReadTime,
    double blkWriteTime,
    long walRecords,
    long walFpi,
    long walBytes,
    double jitGenerationTime,
    double jitInliningTime,
    double jitOptimizationTime,
    double jitEmissionTime
) {}
