package com.pgstat.collector.model;

import java.time.OffsetDateTime;

/**
 * pg_stat_statements'tan okunan tek bir satirin kumulatif degerleri.
 * Delta hesaplamasi icin onceki sample ile karsilastirilir.
 *
 * Note: min/max/stddev *_time alanlari snapshot degerler — delta hesaplanmaz,
 * son okunan deger oldugu gibi yazilir. min_exec_time periyot icindeki en
 * hizli calismayi gosterir; pg_stat_statements_reset'e kadar monotonic degisir.
 *
 * Versiyona ozel kolonlar:
 *   - PG13+: plans, total_plan_time, min/max/stddev_plan_time
 *   - PG14+: toplevel, jit_functions, jit_generation/inlining/optimization/emission_time
 *   - PG15+: temp_blk_read_time, temp_blk_write_time, stats_since, minmax_stats_since
 *   - PG16+: jit_deform_count, jit_deform_time
 *   - PG17+: wal_buffers_full, blk_*_time shared/local/temp split
 *   - PG18+: parallel_workers_to_launch, parallel_workers_launched
 *
 * Eski versiyonlarda yok olan kolonlar 0 (sayisal) veya null (timestamp) doner.
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
    double minExecTime,
    double maxExecTime,
    double stddevExecTime,
    double minPlanTime,
    double maxPlanTime,
    double stddevPlanTime,
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
    double tempBlkReadTime,
    double tempBlkWriteTime,
    long walRecords,
    long walFpi,
    long walBytes,
    long walBuffersFull,
    long jitFunctions,
    double jitGenerationTime,
    double jitInliningTime,
    double jitOptimizationTime,
    double jitEmissionTime,
    long jitDeformCount,
    double jitDeformTime,
    OffsetDateTime statsSince,
    OffsetDateTime minmaxStatsSince,
    long parallelWorkersToLaunch,
    long parallelWorkersLaunched
) {}
