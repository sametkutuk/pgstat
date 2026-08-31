package com.pgstat.collector.repository;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.time.OffsetDateTime;

/**
 * 10 fact tablosu icin INSERT islemleri.
 * Tum INSERT'ler ON CONFLICT DO NOTHING ile idempotent.
 * Mimari dok: satir 3340-3777
 */
@Repository
public class FactRepository {

    private final JdbcTemplate jdbc;

    public FactRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    // -------------------------------------------------------------------------
    // fact.pg_cluster_delta — cluster metrikleri (bgwriter/wal/checkpointer)
    // -------------------------------------------------------------------------

    /**
     * Cluster metrik delta'larini batch olarak yazar.
     * Her metrik icin ayri (metric_family, metric_name, metric_value_num) satiri uretilir.
     *
     * @param sampleTs    ornekleme zamani
     * @param instancePk  instance PK
     * @param family      metrik ailesi (ornek: "pg_stat_bgwriter")
     * @param name        metrik adi (ornek: "buffers_clean")
     * @param value       delta degeri
     */
    public void insertClusterDelta(OffsetDateTime sampleTs, long instancePk,
                                   String family, String name, double value) {
        jdbc.update("""
            insert into fact.pg_cluster_delta (
              sample_ts, instance_pk, metric_family, metric_name, metric_value_num
            )
            values (?, ?, ?, ?, ?)
            on conflict do nothing
            """,
            sampleTs, instancePk, family, name, value
        );
    }

    /**
     * Cluster metrik delta'larini toplu batch ile yazar.
     * Tek SQL icinde birden fazla VALUES satiri gonderir.
     */
    public void insertClusterDeltaBatch(OffsetDateTime sampleTs, long instancePk,
                                        Object[][] metrics) {
        if (metrics.length == 0) return;

        // Her satir: [family, name, value]
        StringBuilder sql = new StringBuilder("""
            insert into fact.pg_cluster_delta (
              sample_ts, instance_pk, metric_family, metric_name, metric_value_num
            ) values
            """);

        Object[] params = new Object[metrics.length * 5];
        for (int i = 0; i < metrics.length; i++) {
            if (i > 0) sql.append(",");
            sql.append(" (?, ?, ?, ?, ?)");
            params[i * 5] = sampleTs;
            params[i * 5 + 1] = instancePk;
            params[i * 5 + 2] = metrics[i][0]; // family
            params[i * 5 + 3] = metrics[i][1]; // name
            params[i * 5 + 4] = metrics[i][2]; // value
        }
        sql.append(" on conflict do nothing");

        jdbc.update(sql.toString(), params);
    }

    // -------------------------------------------------------------------------
    // fact.pg_io_stat_delta — PG16+ pg_stat_io delta'lari
    // -------------------------------------------------------------------------

    public void insertIoStatDelta(OffsetDateTime sampleTs, long instancePk,
                                  String backendType, String object, String context,
                                  Long readsDelta, Double readTimeMsDelta,
                                  Long writesDelta, Double writeTimeMsDelta,
                                  Long extendsDelta, Double extendTimeMsDelta,
                                  Long hitsDelta, Long evictionsDelta,
                                  Long reusesDelta, Long fsyncsDelta,
                                  Double fsyncTimeMsDelta,
                                  Long writebacksDelta, Double writebackTimeMsDelta,
                                  Long opBytes, Long readBytesDelta,
                                  Long writeBytesDelta, Long extendBytesDelta,
                                  OffsetDateTime statsReset) {
        jdbc.update("""
            insert into fact.pg_io_stat_delta (
              sample_ts, instance_pk, backend_type, object, context,
              reads_delta, read_time_ms_delta, writes_delta, write_time_ms_delta,
              extends_delta, extend_time_ms_delta, hits_delta, evictions_delta,
              reuses_delta, fsyncs_delta, fsync_time_ms_delta,
              writebacks_delta, writeback_time_ms_delta, op_bytes,
              read_bytes_delta, write_bytes_delta, extend_bytes_delta, stats_reset
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict do nothing
            """,
            sampleTs, instancePk, backendType, object, context,
            readsDelta, readTimeMsDelta, writesDelta, writeTimeMsDelta,
            extendsDelta, extendTimeMsDelta, hitsDelta, evictionsDelta,
            reusesDelta, fsyncsDelta, fsyncTimeMsDelta,
            writebacksDelta, writebackTimeMsDelta, opBytes,
            readBytesDelta, writeBytesDelta, extendBytesDelta, statsReset
        );
    }

    // -------------------------------------------------------------------------
    // fact.pg_activity_snapshot — pg_stat_activity snapshot
    // -------------------------------------------------------------------------

    public void insertActivitySnapshot(OffsetDateTime snapshotTs, long instancePk,
                                       int pid, String datname, String usename,
                                       String applicationName, String clientAddr,
                                       OffsetDateTime backendStart, OffsetDateTime xactStart,
                                       OffsetDateTime queryStart, OffsetDateTime stateChange,
                                       String state, String waitEventType, String waitEvent,
                                       String query, String backendType,
                                       Long queryId, Integer leaderPid, Long usesysid,
                                       String clientHostname, Integer clientPort,
                                       String backendXid, String backendXmin) {
        jdbc.update("""
            insert into fact.pg_activity_snapshot (
              snapshot_ts, instance_pk, pid, datname, usename,
              application_name, client_addr, backend_start, xact_start,
              query_start, state_change, state, wait_event_type, wait_event,
              query, backend_type,
              query_id, leader_pid, usesysid, client_hostname, client_port,
              backend_xid, backend_xmin
            )
            values (?, ?, ?, ?, ?, ?, ?::inet, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            snapshotTs, instancePk, pid, datname, usename,
            applicationName, clientAddr, backendStart, xactStart,
            queryStart, stateChange, state, waitEventType, waitEvent,
            query, backendType,
            queryId, leaderPid, usesysid, clientHostname, clientPort,
            backendXid, backendXmin
        );
    }

    // -------------------------------------------------------------------------
    // fact.pg_replication_snapshot — pg_stat_replication snapshot
    // -------------------------------------------------------------------------

    public void insertReplicationSnapshot(OffsetDateTime snapshotTs, long instancePk,
                                          int pid, String usename, String applicationName,
                                          String clientAddr, String state,
                                          String sentLsn, String writeLsn,
                                          String flushLsn, String replayLsn,
                                          String writeLag, String flushLag,
                                          String replayLag, String syncState,
                                          Long replayLagBytes,
                                          Long usesysid, String clientHostname,
                                          Integer clientPort, OffsetDateTime backendStart,
                                          String backendXmin, Integer syncPriority,
                                          OffsetDateTime replyTime) {
        jdbc.update("""
            insert into fact.pg_replication_snapshot (
              snapshot_ts, instance_pk, pid, usename, application_name,
              client_addr, state, sent_lsn, write_lsn, flush_lsn, replay_lsn,
              write_lag, flush_lag, replay_lag, sync_state, replay_lag_bytes,
              usesysid, client_hostname, client_port, backend_start,
              backend_xmin, sync_priority, reply_time
            )
            values (?, ?, ?, ?, ?, ?::inet, ?, ?::pg_lsn, ?::pg_lsn, ?::pg_lsn, ?::pg_lsn,
                    ?::interval, ?::interval, ?::interval, ?, ?,
                    ?, ?, ?, ?, ?, ?, ?)
            """,
            snapshotTs, instancePk, pid, usename, applicationName,
            clientAddr, state, sentLsn, writeLsn, flushLsn, replayLsn,
            writeLag, flushLag, replayLag, syncState, replayLagBytes,
            usesysid, clientHostname, clientPort, backendStart,
            backendXmin, syncPriority, replyTime
        );
    }

    // -------------------------------------------------------------------------
    // fact.pg_lock_snapshot — bekleyen lock'lar
    // -------------------------------------------------------------------------

    public void insertLockSnapshot(OffsetDateTime snapshotTs, long instancePk,
                                   int pid, String locktype, Long databaseOid,
                                   Long relationOid, String mode, boolean granted,
                                   OffsetDateTime waitstart, Integer[] blockedByPids) {
        jdbc.update("""
            insert into fact.pg_lock_snapshot (
              snapshot_ts, instance_pk, pid, locktype, database_oid,
              relation_oid, mode, granted, waitstart, blocked_by_pids
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            snapshotTs, instancePk, pid, locktype, databaseOid,
            relationOid, mode, granted, waitstart, blockedByPids
        );
    }

    // -------------------------------------------------------------------------
    // fact.pg_progress_snapshot — aktif operasyon ilerlemesi
    // -------------------------------------------------------------------------

    public void insertProgressSnapshot(OffsetDateTime snapshotTs, long instancePk,
                                       int pid, String command, String datname,
                                       String relname, String phase,
                                       Long blocksTotal, Long blocksDone,
                                       Long tuplesTotal, Long tuplesDone,
                                       Double progressPct) {
        jdbc.update("""
            insert into fact.pg_progress_snapshot (
              snapshot_ts, instance_pk, pid, command, datname, relname,
              phase, blocks_total, blocks_done, tuples_total, tuples_done,
              progress_pct
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            snapshotTs, instancePk, pid, command, datname, relname,
            phase, blocksTotal, blocksDone, tuplesTotal, tuplesDone,
            progressPct
        );
    }

    // -------------------------------------------------------------------------
    // fact.pgss_delta — pg_stat_statements delta
    // -------------------------------------------------------------------------

    public void insertPgssDelta(OffsetDateTime sampleTs, long instancePk,
                                long statementSeriesId,
                                long callsDelta, long plansDelta,
                                double totalPlanTimeMsDelta, double totalExecTimeMsDelta,
                                long rowsDelta,
                                long sharedBlksHitDelta, long sharedBlksReadDelta,
                                long sharedBlksDirtiedDelta, long sharedBlksWrittenDelta,
                                long localBlksHitDelta, long localBlksReadDelta,
                                long localBlksDirtiedDelta, long localBlksWrittenDelta,
                                long tempBlksReadDelta, long tempBlksWrittenDelta,
                                double blkReadTimeMsDelta, double blkWriteTimeMsDelta,
                                long walRecordsDelta, long walFpiDelta,
                                long walBytesDelta,
                                double jitGenTimeMsDelta, double jitInlTimeMsDelta,
                                double jitOptTimeMsDelta, double jitEmitTimeMsDelta,
                                // V055 ile eklenen kolonlar (Kiro db73994)
                                double minExecTimeMs, double maxExecTimeMs, double stddevExecTimeMs,
                                double minPlanTimeMs, double maxPlanTimeMs, double stddevPlanTimeMs,
                                double tempBlkReadTimeMsDelta, double tempBlkWriteTimeMsDelta,
                                long walBuffersFullDelta,
                                long jitFunctionsDelta, long jitDeformCountDelta, double jitDeformTimeMsDelta,
                                OffsetDateTime statsSince, OffsetDateTime minmaxStatsSince,
                                long parallelWorkersToLaunchDelta, long parallelWorkersLaunchedDelta,
                                // V066 ile eklenen kolonlar (Kiro tarafindan persist edilmemisti)
                                double meanExecTimeMs, double meanPlanTimeMs,
                                long jitInliningCount, long jitOptimizationCount, long jitEmissionCount,
                                double sharedBlkReadTimeMsDelta, double sharedBlkWriteTimeMsDelta,
                                double localBlkReadTimeMsDelta, double localBlkWriteTimeMsDelta) {
        jdbc.update("""
            insert into fact.pgss_delta (
              sample_ts, instance_pk, statement_series_id,
              calls_delta, plans_delta,
              total_plan_time_ms_delta, total_exec_time_ms_delta,
              rows_delta,
              shared_blks_hit_delta, shared_blks_read_delta,
              shared_blks_dirtied_delta, shared_blks_written_delta,
              local_blks_hit_delta, local_blks_read_delta,
              local_blks_dirtied_delta, local_blks_written_delta,
              temp_blks_read_delta, temp_blks_written_delta,
              blk_read_time_ms_delta, blk_write_time_ms_delta,
              wal_records_delta, wal_fpi_delta, wal_bytes_delta,
              jit_generation_time_ms_delta, jit_inlining_time_ms_delta,
              jit_optimization_time_ms_delta, jit_emission_time_ms_delta,
              min_exec_time_ms, max_exec_time_ms, stddev_exec_time_ms,
              min_plan_time_ms, max_plan_time_ms, stddev_plan_time_ms,
              temp_blk_read_time_ms_delta, temp_blk_write_time_ms_delta,
              wal_buffers_full_delta,
              jit_functions_delta, jit_deform_count_delta, jit_deform_time_ms_delta,
              stats_since, minmax_stats_since,
              parallel_workers_to_launch_delta, parallel_workers_launched_delta,
              mean_exec_time_ms, mean_plan_time_ms,
              jit_inlining_count, jit_optimization_count, jit_emission_count,
              shared_blk_read_time_ms_delta, shared_blk_write_time_ms_delta,
              local_blk_read_time_ms_delta, local_blk_write_time_ms_delta
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict do nothing
            """,
            sampleTs, instancePk, statementSeriesId,
            callsDelta, plansDelta,
            totalPlanTimeMsDelta, totalExecTimeMsDelta,
            rowsDelta,
            sharedBlksHitDelta, sharedBlksReadDelta,
            sharedBlksDirtiedDelta, sharedBlksWrittenDelta,
            localBlksHitDelta, localBlksReadDelta,
            localBlksDirtiedDelta, localBlksWrittenDelta,
            tempBlksReadDelta, tempBlksWrittenDelta,
            blkReadTimeMsDelta, blkWriteTimeMsDelta,
            walRecordsDelta, walFpiDelta, walBytesDelta,
            jitGenTimeMsDelta, jitInlTimeMsDelta,
            jitOptTimeMsDelta, jitEmitTimeMsDelta,
            minExecTimeMs, maxExecTimeMs, stddevExecTimeMs,
            minPlanTimeMs, maxPlanTimeMs, stddevPlanTimeMs,
            tempBlkReadTimeMsDelta, tempBlkWriteTimeMsDelta,
            walBuffersFullDelta,
            jitFunctionsDelta, jitDeformCountDelta, jitDeformTimeMsDelta,
            statsSince, minmaxStatsSince,
            parallelWorkersToLaunchDelta, parallelWorkersLaunchedDelta,
            meanExecTimeMs, meanPlanTimeMs,
            jitInliningCount, jitOptimizationCount, jitEmissionCount,
            sharedBlkReadTimeMsDelta, sharedBlkWriteTimeMsDelta,
            localBlkReadTimeMsDelta, localBlkWriteTimeMsDelta
        );
    }

    // -------------------------------------------------------------------------
    // fact.pg_database_delta — pg_stat_database delta
    // -------------------------------------------------------------------------

    public void insertDatabaseDelta(OffsetDateTime sampleTs, long instancePk,
                                    long dbid, String datname, int numbackends,
                                    long xactCommitDelta, long xactRollbackDelta,
                                    long blksReadDelta, long blksHitDelta,
                                    long tupReturnedDelta, long tupFetchedDelta,
                                    long tupInsertedDelta, long tupUpdatedDelta,
                                    long tupDeletedDelta, long conflictsDelta,
                                    long tempFilesDelta, long tempBytesDelta,
                                    long deadlocksDelta, long checksumFailuresDelta,
                                    double blkReadTimeMsDelta, double blkWriteTimeMsDelta,
                                    double sessionTimeMsDelta, double activeTimeMsDelta,
                                    double idleInTxTimeMsDelta,
                                    Long sessionsDelta, Long sessionsAbandonedDelta,
                                    Long sessionsFatalDelta, Long sessionsKilledDelta,
                                    OffsetDateTime statsReset, OffsetDateTime checksumLastFailure,
                                    Long parallelWorkersToLaunchDelta, Long parallelWorkersLaunchedDelta) {
        jdbc.update("""
            insert into fact.pg_database_delta (
              sample_ts, instance_pk, dbid, datname, numbackends,
              xact_commit_delta, xact_rollback_delta,
              blks_read_delta, blks_hit_delta,
              tup_returned_delta, tup_fetched_delta,
              tup_inserted_delta, tup_updated_delta, tup_deleted_delta,
              conflicts_delta, temp_files_delta, temp_bytes_delta,
              deadlocks_delta, checksum_failures_delta,
              blk_read_time_ms_delta, blk_write_time_ms_delta,
              session_time_ms_delta, active_time_ms_delta,
              idle_in_transaction_time_ms_delta,
              sessions_delta, sessions_abandoned_delta,
              sessions_fatal_delta, sessions_killed_delta,
              stats_reset, checksum_last_failure,
              parallel_workers_to_launch_delta, parallel_workers_launched_delta
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict do nothing
            """,
            sampleTs, instancePk, dbid, datname, numbackends,
            xactCommitDelta, xactRollbackDelta,
            blksReadDelta, blksHitDelta,
            tupReturnedDelta, tupFetchedDelta,
            tupInsertedDelta, tupUpdatedDelta, tupDeletedDelta,
            conflictsDelta, tempFilesDelta, tempBytesDelta,
            deadlocksDelta, checksumFailuresDelta,
            blkReadTimeMsDelta, blkWriteTimeMsDelta,
            sessionTimeMsDelta, activeTimeMsDelta,
            idleInTxTimeMsDelta,
            sessionsDelta, sessionsAbandonedDelta,
            sessionsFatalDelta, sessionsKilledDelta,
            statsReset, checksumLastFailure,
            parallelWorkersToLaunchDelta, parallelWorkersLaunchedDelta
        );
    }

    // -------------------------------------------------------------------------
    // fact.pg_table_stat_delta — per-table istatistik delta
    // -------------------------------------------------------------------------

    public void insertTableStatDelta(OffsetDateTime sampleTs, long instancePk,
                                     long dbid, long relid, String schemaname, String relname,
                                     long seqScanDelta, long seqTupReadDelta,
                                     long idxScanDelta, long idxTupFetchDelta,
                                     long nTupInsDelta, long nTupUpdDelta,
                                     long nTupDelDelta, long nTupHotUpdDelta,
                                     long vacuumCountDelta, long autovacuumCountDelta,
                                     long analyzeCountDelta, long autoanalyzeCountDelta,
                                     long heapBlksReadDelta, long heapBlksHitDelta,
                                     long idxBlksReadDelta, long idxBlksHitDelta,
                                     long toastBlksReadDelta, long toastBlksHitDelta,
                                     long tidxBlksReadDelta, long tidxBlksHitDelta,
                                     long nLiveTupEstimate, long nDeadTupEstimate,
                                     long nModSinceAnalyze,
                                     OffsetDateTime lastVacuum, OffsetDateTime lastAutovacuum,
                                     OffsetDateTime lastAnalyze, OffsetDateTime lastAutoanalyze,
                                     long nInsSinceVacuum, OffsetDateTime lastSeqScan,
                                     OffsetDateTime lastIdxScan, long nTupNewpageUpd,
                                     double totalVacuumTimeMsDelta, double totalAutovacuumTimeMsDelta,
                                     double totalAnalyzeTimeMsDelta, double totalAutoanalyzeTimeMsDelta,
                                     Long reltuples) {
        jdbc.update("""
            insert into fact.pg_table_stat_delta (
              sample_ts, instance_pk, dbid, relid, schemaname, relname,
              seq_scan_delta, seq_tup_read_delta, idx_scan_delta, idx_tup_fetch_delta,
              n_tup_ins_delta, n_tup_upd_delta, n_tup_del_delta, n_tup_hot_upd_delta,
              vacuum_count_delta, autovacuum_count_delta,
              analyze_count_delta, autoanalyze_count_delta,
              heap_blks_read_delta, heap_blks_hit_delta,
              idx_blks_read_delta, idx_blks_hit_delta,
              toast_blks_read_delta, toast_blks_hit_delta,
              tidx_blks_read_delta, tidx_blks_hit_delta,
              n_live_tup_estimate, n_dead_tup_estimate, n_mod_since_analyze,
              last_vacuum, last_autovacuum, last_analyze, last_autoanalyze,
              n_ins_since_vacuum, last_seq_scan, last_idx_scan, n_tup_newpage_upd,
              total_vacuum_time_ms_delta, total_autovacuum_time_ms_delta,
              total_analyze_time_ms_delta, total_autoanalyze_time_ms_delta,
              reltuples
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict do nothing
            """,
            sampleTs, instancePk, dbid, relid, schemaname, relname,
            seqScanDelta, seqTupReadDelta, idxScanDelta, idxTupFetchDelta,
            nTupInsDelta, nTupUpdDelta, nTupDelDelta, nTupHotUpdDelta,
            vacuumCountDelta, autovacuumCountDelta,
            analyzeCountDelta, autoanalyzeCountDelta,
            heapBlksReadDelta, heapBlksHitDelta,
            idxBlksReadDelta, idxBlksHitDelta,
            toastBlksReadDelta, toastBlksHitDelta,
            tidxBlksReadDelta, tidxBlksHitDelta,
            nLiveTupEstimate, nDeadTupEstimate, nModSinceAnalyze,
            lastVacuum, lastAutovacuum, lastAnalyze, lastAutoanalyze,
            nInsSinceVacuum, lastSeqScan, lastIdxScan, nTupNewpageUpd,
            totalVacuumTimeMsDelta, totalAutovacuumTimeMsDelta,
            totalAnalyzeTimeMsDelta, totalAutoanalyzeTimeMsDelta,
            reltuples
        );
    }

    /**
     * Tablo-ozel autovacuum override'larini (pg_class.reloptions) upsert eder.
     * Delta degil, nadiren degisen bir konfigurasyon — her toplama
     * donguesunde ayni satir guncellenir (V093, PGSTAT-P0-036 AC6;
     * cost kolonlari V095, PGSTAT-P1-011).
     *
     * autovacuum_enabled disinda cost_delay/cost_limit de ayristirilip
     * kendi kolonlarina yaziliyor — dead_tuple_ratio teshisinin etkin cost
     * ayari zinciri bunlari her okumada ham metinden parse etmek yerine
     * dogrudan kolondan okuyabilsin diye.
     *
     * @param reloptionsRaw virgulle ayrilmis reloptions dizisi (orn.
     *                      "autovacuum_enabled=false,fillfactor=90"), null/bos
     *                      olabilir (override yoksa)
     */
    public void upsertTableRelOptions(long instancePk, long dbid, long relid,
                                       String schemaname, String relname, String reloptionsRaw) {
        Boolean autovacuumEnabled = null;
        if (reloptionsRaw != null) {
            for (String opt : reloptionsRaw.split(",")) {
                if (opt.trim().startsWith("autovacuum_enabled=")) {
                    autovacuumEnabled = opt.trim().endsWith("=true");
                }
            }
        }
        Integer costDelay = parseIntRelOption(reloptionsRaw, "autovacuum_vacuum_cost_delay");
        Integer costLimit = parseIntRelOption(reloptionsRaw, "autovacuum_vacuum_cost_limit");
        // fillfactor: 100 altindaki degerde sayfalarin bir kismi HOT update icin
        // BILEREK bos birakilir. Fiziksel sisme hesabinda dusulmezse tasarim
        // geregi bos alan sisme sanilir (V104).
        Integer fillfactor = parseIntRelOption(reloptionsRaw, "fillfactor");
        jdbc.update("""
            insert into control.table_relopts_snapshot
              (instance_pk, dbid, relid, schemaname, relname, autovacuum_enabled, reloptions_raw,
               autovacuum_vacuum_cost_delay, autovacuum_vacuum_cost_limit, fillfactor, updated_at)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now())
            on conflict (instance_pk, dbid, relid) do update set
              schemaname = excluded.schemaname,
              relname = excluded.relname,
              autovacuum_enabled = excluded.autovacuum_enabled,
              reloptions_raw = excluded.reloptions_raw,
              autovacuum_vacuum_cost_delay = excluded.autovacuum_vacuum_cost_delay,
              autovacuum_vacuum_cost_limit = excluded.autovacuum_vacuum_cost_limit,
              fillfactor = excluded.fillfactor,
              updated_at = now()
            """,
            instancePk, dbid, relid, schemaname, relname, autovacuumEnabled, reloptionsRaw,
            costDelay, costLimit, fillfactor
        );
    }

    /**
     * Ham reloptions metninden tek bir tamsayi secenegi cikarir.
     * Bulunamazsa veya parse edilemezse null — "override yok" ile
     * "override var ve degeri 0" farkli seylerdir, ikisi karistirilmamali.
     * -1 gecerli bir degerdir (sentinel: global ayari kullan).
     */
    public static Integer parseIntRelOption(String reloptionsRaw, String optionName) {
        if (reloptionsRaw == null || reloptionsRaw.isBlank()) {
            return null;
        }
        for (String part : reloptionsRaw.replace("{", "").replace("}", "").split(",")) {
            String[] kv = part.split("=", 2);
            if (kv.length == 2 && kv[0].trim().equalsIgnoreCase(optionName)) {
                try {
                    return Integer.parseInt(kv[1].trim());
                } catch (NumberFormatException e) {
                    return null;
                }
            }
        }
        return null;
    }

    // -------------------------------------------------------------------------
    // fact.pg_index_stat_delta — per-index istatistik delta
    // -------------------------------------------------------------------------

    public void insertIndexStatDelta(OffsetDateTime sampleTs, long instancePk,
                                     long dbid, long tableRelid, long indexRelid,
                                     String schemaname, String tableRelname,
                                     String indexRelname,
                                     long idxScanDelta, long idxTupReadDelta,
                                     long idxTupFetchDelta,
                                     long idxBlksReadDelta, long idxBlksHitDelta,
                                     Boolean isValid, Boolean isReady,
                                     Boolean isPrimary, Boolean isUnique,
                                     OffsetDateTime lastIdxScan) {
        jdbc.update("""
            insert into fact.pg_index_stat_delta (
              sample_ts, instance_pk, dbid, table_relid, index_relid,
              schemaname, table_relname, index_relname,
              idx_scan_delta, idx_tup_read_delta, idx_tup_fetch_delta,
              idx_blks_read_delta, idx_blks_hit_delta,
              is_valid, is_ready, is_primary, is_unique,
              last_idx_scan
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict do nothing
            """,
            sampleTs, instancePk, dbid, tableRelid, indexRelid,
            schemaname, tableRelname, indexRelname,
            idxScanDelta, idxTupReadDelta, idxTupFetchDelta,
            idxBlksReadDelta, idxBlksHitDelta,
            isValid, isReady, isPrimary, isUnique,
            lastIdxScan
        );
    }

    // -------------------------------------------------------------------------
    // fact.pg_wal_snapshot — WAL LSN ve waldir boyutu
    // -------------------------------------------------------------------------

    public void insertWalSnapshot(OffsetDateTime sampleTs, long instancePk,
                                  String currentLsn, String currentFile,
                                  Long walDirSizeByte, Integer walFileCount,
                                  Long periodSizeByte) {
        jdbc.update("""
            insert into fact.pg_wal_snapshot (
              sample_ts, instance_pk, current_wal_lsn, current_wal_file,
              wal_directory_size_byte, wal_file_count, period_wal_size_byte
            )
            values (?, ?, ?, ?, ?, ?, ?)
            on conflict do nothing
            """,
            sampleTs, instancePk, currentLsn, currentFile,
            walDirSizeByte, walFileCount, periodSizeByte
        );
    }

    // -------------------------------------------------------------------------
    // fact.pg_archiver_snapshot — pg_stat_archiver
    // -------------------------------------------------------------------------

    public void insertArchiverSnapshot(OffsetDateTime sampleTs, long instancePk,
                                       Long archivedCount, String lastArchivedWal,
                                       OffsetDateTime lastArchivedTime,
                                       Long failedCount, String lastFailedWal,
                                       OffsetDateTime lastFailedTime,
                                       OffsetDateTime statsReset) {
        jdbc.update("""
            insert into fact.pg_archiver_snapshot (
              sample_ts, instance_pk, archived_count, last_archived_wal, last_archived_time,
              failed_count, last_failed_wal, last_failed_time, stats_reset
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict do nothing
            """,
            sampleTs, instancePk, archivedCount, lastArchivedWal, lastArchivedTime,
            failedCount, lastFailedWal, lastFailedTime, statsReset
        );
    }

    // -------------------------------------------------------------------------
    // fact.pg_wal_receiver_snapshot — pg_stat_wal_receiver (standby only)
    // -------------------------------------------------------------------------

    public void insertWalReceiverSnapshot(OffsetDateTime sampleTs, long instancePk,
                                          Integer pid, String status,
                                          String receiveStartLsn, Integer receiveStartTli,
                                          String writtenLsn, String flushedLsn,
                                          Integer receivedTli,
                                          OffsetDateTime lastMsgSendTime,
                                          OffsetDateTime lastMsgReceiptTime,
                                          String latestEndLsn, OffsetDateTime latestEndTime,
                                          String slotName, String senderHost,
                                          Integer senderPort, Long lagBytes) {
        jdbc.update("""
            insert into fact.pg_wal_receiver_snapshot (
              sample_ts, instance_pk, pid, status,
              receive_start_lsn, receive_start_tli, written_lsn, flushed_lsn,
              received_tli, last_msg_send_time, last_msg_receipt_time,
              latest_end_lsn, latest_end_time, slot_name,
              sender_host, sender_port, lag_bytes
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict do nothing
            """,
            sampleTs, instancePk, pid, status,
            receiveStartLsn, receiveStartTli, writtenLsn, flushedLsn,
            receivedTli, lastMsgSendTime, lastMsgReceiptTime,
            latestEndLsn, latestEndTime, slotName,
            senderHost, senderPort, lagBytes
        );
    }

    // -------------------------------------------------------------------------
    // fact.pg_replication_slot_snapshot
    // -------------------------------------------------------------------------

    public void insertSlotSnapshot(OffsetDateTime sampleTs, long instancePk,
                                   String slotName, String plugin, String slotType,
                                   String database, Boolean active, Integer activePid,
                                   Long xmin, Long catalogXmin, String restartLsn,
                                   String confirmedFlushLsn, String walStatus,
                                   Long safeWalSize, Long slotLagBytes,
                                   Long spillTxns, Long spillCount, Long spillBytes,
                                   Long streamTxns, Long streamCount, Long streamBytes,
                                   Long totalTxns, Long totalBytes,
                                   OffsetDateTime statsReset,
                                   Boolean temporary, Boolean twoPhase,
                                   Boolean conflicting, String invalidationReason,
                                   Boolean failover, Boolean synced) {
        jdbc.update("""
            insert into fact.pg_replication_slot_snapshot (
              sample_ts, instance_pk, slot_name, plugin, slot_type, database,
              active, active_pid, xmin_int, catalog_xmin_int, restart_lsn,
              confirmed_flush_lsn, wal_status, safe_wal_size, slot_lag_bytes,
              spill_txns, spill_count, spill_bytes,
              stream_txns, stream_count, stream_bytes,
              total_txns, total_bytes, stats_reset,
              temporary, two_phase, conflicting, invalidation_reason, failover, synced
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?)
            on conflict do nothing
            """,
            sampleTs, instancePk, slotName, plugin, slotType, database,
            active, activePid, xmin, catalogXmin, restartLsn,
            confirmedFlushLsn, walStatus, safeWalSize, slotLagBytes,
            spillTxns, spillCount, spillBytes,
            streamTxns, streamCount, streamBytes,
            totalTxns, totalBytes, statsReset,
            temporary, twoPhase, conflicting, invalidationReason, failover, synced
        );
    }

    // -------------------------------------------------------------------------
    // fact.pg_database_conflict_snapshot
    // -------------------------------------------------------------------------

    public void insertConflictSnapshot(OffsetDateTime sampleTs, long instancePk,
                                       String datname, Long conflTablespace,
                                       Long conflLock, Long conflSnapshot,
                                       Long conflBufferpin, Long conflDeadlock,
                                       Long datid, Long conflActiveLogicalslot) {
        jdbc.update("""
            insert into fact.pg_database_conflict_snapshot (
              sample_ts, instance_pk, datname,
              confl_tablespace, confl_lock, confl_snapshot, confl_bufferpin, confl_deadlock,
              datid, confl_active_logicalslot
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict do nothing
            """,
            sampleTs, instancePk, datname, conflTablespace,
            conflLock, conflSnapshot, conflBufferpin, conflDeadlock,
            datid, conflActiveLogicalslot
        );
    }

    // -------------------------------------------------------------------------
    // fact.pg_slru_snapshot
    // -------------------------------------------------------------------------

    public void insertSlruSnapshot(OffsetDateTime sampleTs, long instancePk,
                                   String name, Long blksZeroed, Long blksHit,
                                   Long blksRead, Long blksWritten, Long blksExists,
                                   Long flushes, Long truncates,
                                   OffsetDateTime statsReset) {
        jdbc.update("""
            insert into fact.pg_slru_snapshot (
              sample_ts, instance_pk, name,
              blks_zeroed, blks_hit, blks_read, blks_written, blks_exists,
              flushes, truncates, stats_reset
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict do nothing
            """,
            sampleTs, instancePk, name,
            blksZeroed, blksHit, blksRead, blksWritten, blksExists,
            flushes, truncates, statsReset
        );
    }

    // -------------------------------------------------------------------------
    // fact.pg_subscription_snapshot
    // -------------------------------------------------------------------------

    public void insertSubscriptionSnapshot(OffsetDateTime sampleTs, long instancePk,
                                           long subid, String subname, Integer pid,
                                           Long relid, String receivedLsn,
                                           OffsetDateTime lastMsgSendTime,
                                           OffsetDateTime lastMsgReceiptTime,
                                           String latestEndLsn, OffsetDateTime latestEndTime,
                                           Long lagBytes, Long applyErrorCount,
                                           Long syncErrorCount, OffsetDateTime statsReset,
                                           Integer leaderPid, String workerType,
                                           long conflInsertExists, long conflUpdateOriginDiffers,
                                           long conflUpdateExists, long conflUpdateMissing,
                                           long conflDeleteOriginDiffers, long conflDeleteMissing,
                                           long conflMultipleUniqueConflicts) {
        jdbc.update("""
            insert into fact.pg_subscription_snapshot (
              sample_ts, instance_pk, subid, subname, pid, relid,
              received_lsn, last_msg_send_time, last_msg_receipt_time,
              latest_end_lsn, latest_end_time, lag_bytes,
              apply_error_count, sync_error_count, stats_reset,
              leader_pid, worker_type,
              confl_insert_exists_delta, confl_update_origin_differs_delta,
              confl_update_exists_delta, confl_update_missing_delta,
              confl_delete_origin_differs_delta, confl_delete_missing_delta,
              confl_multiple_unique_conflicts_delta
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict do nothing
            """,
            sampleTs, instancePk, subid, subname, pid, relid,
            receivedLsn, lastMsgSendTime, lastMsgReceiptTime,
            latestEndLsn, latestEndTime, lagBytes,
            applyErrorCount, syncErrorCount, statsReset,
            leaderPid, workerType,
            conflInsertExists, conflUpdateOriginDiffers,
            conflUpdateExists, conflUpdateMissing,
            conflDeleteOriginDiffers, conflDeleteMissing,
            conflMultipleUniqueConflicts
        );
    }

    // -------------------------------------------------------------------------
    // fact.pg_recovery_prefetch_snapshot
    // -------------------------------------------------------------------------

    public void insertRecoveryPrefetchSnapshot(OffsetDateTime sampleTs, long instancePk,
                                                Long prefetch, Long hit, Long skipInit,
                                                Long skipNew, Long skipFpw, Long skipRep,
                                                OffsetDateTime statsReset, Long walDistance,
                                                Long blockDistance, Long ioDepth) {
        jdbc.update("""
            insert into fact.pg_recovery_prefetch_snapshot (
              sample_ts, instance_pk,
              prefetch, hit, skip_init, skip_new, skip_fpw, skip_rep,
              stats_reset, wal_distance, block_distance, io_depth
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict do nothing
            """,
            sampleTs, instancePk,
            prefetch, hit, skipInit, skipNew, skipFpw, skipRep,
            statsReset, walDistance, blockDistance, ioDepth
        );
    }

    // -------------------------------------------------------------------------
    // fact.pg_user_function_snapshot
    // -------------------------------------------------------------------------

    public void insertUserFunctionSnapshot(OffsetDateTime sampleTs, long instancePk,
                                           long dbid, long funcid, String schemaname,
                                           String funcname, Long calls,
                                           java.math.BigDecimal totalTime,
                                           java.math.BigDecimal selfTime) {
        jdbc.update("""
            insert into fact.pg_user_function_snapshot (
              sample_ts, instance_pk, dbid, funcid,
              schemaname, funcname, calls, total_time, self_time
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict do nothing
            """,
            sampleTs, instancePk, dbid, funcid,
            schemaname, funcname, calls, totalTime, selfTime
        );
    }

    // -------------------------------------------------------------------------
    // fact.pg_sequence_io_snapshot
    // -------------------------------------------------------------------------

    public void insertSequenceIoSnapshot(OffsetDateTime sampleTs, long instancePk,
                                         long dbid, long relid, String schemaname,
                                         String relname, Long blksRead, Long blksHit) {
        jdbc.update("""
            insert into fact.pg_sequence_io_snapshot (
              sample_ts, instance_pk, dbid, relid,
              schemaname, relname, blks_read, blks_hit
            )
            values (?, ?, ?, ?, ?, ?, ?, ?)
            on conflict do nothing
            """,
            sampleTs, instancePk, dbid, relid,
            schemaname, relname, blksRead, blksHit
        );
    }

    // -------------------------------------------------------------------------
    // fact.pg_progress_vacuum_snapshot (Madde 8)
    // -------------------------------------------------------------------------

    public void insertProgressVacuumSnapshot(OffsetDateTime sampleTs, long instancePk,
                                             int pid, Long datid, String datname, Long relid,
                                             String phase, Long heapBlksTotal, Long heapBlksScanned,
                                             Long heapBlksVacuumed, Long indexVacuumCount,
                                             Long maxDeadItemIds, Long maxDeadTupleBytes,
                                             Long numDeadItemIds, Long deadTupleBytes,
                                             Long indexesTotal, Long indexesProcessed) {
        jdbc.update("""
            insert into fact.pg_progress_vacuum_snapshot (
              sample_ts, instance_pk, pid, datid, datname, relid, phase,
              heap_blks_total, heap_blks_scanned, heap_blks_vacuumed,
              index_vacuum_count, max_dead_item_ids, max_dead_tuple_bytes,
              num_dead_item_ids, dead_tuple_bytes, indexes_total, indexes_processed
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict do nothing
            """,
            sampleTs, instancePk, pid, datid, datname, relid, phase,
            heapBlksTotal, heapBlksScanned, heapBlksVacuumed,
            indexVacuumCount, maxDeadItemIds, maxDeadTupleBytes,
            numDeadItemIds, deadTupleBytes, indexesTotal, indexesProcessed
        );
    }

    // -------------------------------------------------------------------------
    // fact.pg_progress_analyze_snapshot (Madde 9)
    // -------------------------------------------------------------------------

    public void insertProgressAnalyzeSnapshot(OffsetDateTime sampleTs, long instancePk,
                                              int pid, Long datid, String datname, Long relid,
                                              String phase, Long sampleBlksTotal, Long sampleBlksScanned,
                                              Long extStatsTotal, Long extStatsComputed,
                                              Long childTablesTotal, Long childTablesDone,
                                              Long currentChildTableRelid) {
        jdbc.update("""
            insert into fact.pg_progress_analyze_snapshot (
              sample_ts, instance_pk, pid, datid, datname, relid, phase,
              sample_blks_total, sample_blks_scanned, ext_stats_total, ext_stats_computed,
              child_tables_total, child_tables_done, current_child_table_relid
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict do nothing
            """,
            sampleTs, instancePk, pid, datid, datname, relid, phase,
            sampleBlksTotal, sampleBlksScanned, extStatsTotal, extStatsComputed,
            childTablesTotal, childTablesDone, currentChildTableRelid
        );
    }

    // -------------------------------------------------------------------------
    // fact.pg_progress_create_index_snapshot (Madde 10)
    // -------------------------------------------------------------------------

    public void insertProgressCreateIndexSnapshot(OffsetDateTime sampleTs, long instancePk,
                                                   int pid, Long datid, String datname, Long relid,
                                                   Long indexRelid, String command, String phase,
                                                   Long lockersTotal, Long lockersDone, Long currentLockerPid,
                                                   Long blocksTotal, Long blocksDone,
                                                   Long tuplesTotal, Long tuplesDone,
                                                   Long partitionsTotal, Long partitionsDone) {
        jdbc.update("""
            insert into fact.pg_progress_create_index_snapshot (
              sample_ts, instance_pk, pid, datid, datname, relid, index_relid,
              command, phase, lockers_total, lockers_done, current_locker_pid,
              blocks_total, blocks_done, tuples_total, tuples_done,
              partitions_total, partitions_done
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict do nothing
            """,
            sampleTs, instancePk, pid, datid, datname, relid, indexRelid,
            command, phase, lockersTotal, lockersDone, currentLockerPid,
            blocksTotal, blocksDone, tuplesTotal, tuplesDone,
            partitionsTotal, partitionsDone
        );
    }

    // -------------------------------------------------------------------------
    // fact.pg_progress_basebackup_snapshot (Madde 11)
    // -------------------------------------------------------------------------

    public void insertProgressBasebackupSnapshot(OffsetDateTime sampleTs, long instancePk,
                                                  int pid, String phase,
                                                  Long backupTotal, Long backupStreamed,
                                                  Long tablespacesTotal, Long tablespacesStreamed) {
        jdbc.update("""
            insert into fact.pg_progress_basebackup_snapshot (
              sample_ts, instance_pk, pid, phase,
              backup_total, backup_streamed, tablespaces_total, tablespaces_streamed
            )
            values (?, ?, ?, ?, ?, ?, ?, ?)
            on conflict do nothing
            """,
            sampleTs, instancePk, pid, phase,
            backupTotal, backupStreamed, tablespacesTotal, tablespacesStreamed
        );
    }

    // -------------------------------------------------------------------------
    // fact.pg_progress_copy_snapshot (Madde 12)
    // -------------------------------------------------------------------------

    public void insertProgressCopySnapshot(OffsetDateTime sampleTs, long instancePk,
                                           int pid, Long datid, String datname, Long relid,
                                           String command, String copyType,
                                           Long bytesProcessed, Long bytesTotal,
                                           Long tuplesProcessed, Long tuplesExcluded,
                                           Long tuplesSkipped) {
        jdbc.update("""
            insert into fact.pg_progress_copy_snapshot (
              sample_ts, instance_pk, pid, datid, datname, relid,
              command, copy_type, bytes_processed, bytes_total,
              tuples_processed, tuples_excluded, tuples_skipped
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict do nothing
            """,
            sampleTs, instancePk, pid, datid, datname, relid,
            command, copyType, bytesProcessed, bytesTotal,
            tuplesProcessed, tuplesExcluded, tuplesSkipped
        );
    }

    // -------------------------------------------------------------------------
    // fact.pg_progress_cluster_snapshot (Madde 13)
    // -------------------------------------------------------------------------

    public void insertProgressClusterSnapshot(OffsetDateTime sampleTs, long instancePk,
                                              int pid, Long datid, String datname, Long relid,
                                              String command, String phase, Long clusterIndexRelid,
                                              Long heapTuplesScanned, Long heapTuplesWritten,
                                              Long heapBlksTotal, Long heapBlksScanned,
                                              Long indexRebuildCount) {
        jdbc.update("""
            insert into fact.pg_progress_cluster_snapshot (
              sample_ts, instance_pk, pid, datid, datname, relid,
              command, phase, cluster_index_relid,
              heap_tuples_scanned, heap_tuples_written,
              heap_blks_total, heap_blks_scanned, index_rebuild_count
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict do nothing
            """,
            sampleTs, instancePk, pid, datid, datname, relid,
            command, phase, clusterIndexRelid,
            heapTuplesScanned, heapTuplesWritten,
            heapBlksTotal, heapBlksScanned, indexRebuildCount
        );
    }
}
