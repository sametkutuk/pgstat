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
                                  Double fsyncTimeMsDelta) {
        jdbc.update("""
            insert into fact.pg_io_stat_delta (
              sample_ts, instance_pk, backend_type, object, context,
              reads_delta, read_time_ms_delta, writes_delta, write_time_ms_delta,
              extends_delta, extend_time_ms_delta, hits_delta, evictions_delta,
              reuses_delta, fsyncs_delta, fsync_time_ms_delta
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict do nothing
            """,
            sampleTs, instancePk, backendType, object, context,
            readsDelta, readTimeMsDelta, writesDelta, writeTimeMsDelta,
            extendsDelta, extendTimeMsDelta, hitsDelta, evictionsDelta,
            reusesDelta, fsyncsDelta, fsyncTimeMsDelta
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
                                       String query, String backendType) {
        jdbc.update("""
            insert into fact.pg_activity_snapshot (
              snapshot_ts, instance_pk, pid, datname, usename,
              application_name, client_addr, backend_start, xact_start,
              query_start, state_change, state, wait_event_type, wait_event,
              query, backend_type
            )
            values (?, ?, ?, ?, ?, ?, ?::inet, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            snapshotTs, instancePk, pid, datname, usename,
            applicationName, clientAddr, backendStart, xactStart,
            queryStart, stateChange, state, waitEventType, waitEvent,
            query, backendType
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
                                          Long replayLagBytes) {
        jdbc.update("""
            insert into fact.pg_replication_snapshot (
              snapshot_ts, instance_pk, pid, usename, application_name,
              client_addr, state, sent_lsn, write_lsn, flush_lsn, replay_lsn,
              write_lag, flush_lag, replay_lag, sync_state, replay_lag_bytes
            )
            values (?, ?, ?, ?, ?, ?::inet, ?, ?::pg_lsn, ?::pg_lsn, ?::pg_lsn, ?::pg_lsn,
                    ?::interval, ?::interval, ?::interval, ?, ?)
            """,
            snapshotTs, instancePk, pid, usename, applicationName,
            clientAddr, state, sentLsn, writeLsn, flushLsn, replayLsn,
            writeLag, flushLag, replayLag, syncState, replayLagBytes
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
                                double jitOptTimeMsDelta, double jitEmitTimeMsDelta) {
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
              jit_optimization_time_ms_delta, jit_emission_time_ms_delta
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            jitOptTimeMsDelta, jitEmitTimeMsDelta
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
                                    double idleInTxTimeMsDelta) {
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
              idle_in_transaction_time_ms_delta
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            idleInTxTimeMsDelta
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
                                     long nModSinceAnalyze) {
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
              n_live_tup_estimate, n_dead_tup_estimate, n_mod_since_analyze
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            nLiveTupEstimate, nDeadTupEstimate, nModSinceAnalyze
        );
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
                                     long idxBlksReadDelta, long idxBlksHitDelta) {
        jdbc.update("""
            insert into fact.pg_index_stat_delta (
              sample_ts, instance_pk, dbid, table_relid, index_relid,
              schemaname, table_relname, index_relname,
              idx_scan_delta, idx_tup_read_delta, idx_tup_fetch_delta,
              idx_blks_read_delta, idx_blks_hit_delta
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict do nothing
            """,
            sampleTs, instancePk, dbid, tableRelid, indexRelid,
            schemaname, tableRelname, indexRelname,
            idxScanDelta, idxTupReadDelta, idxTupFetchDelta,
            idxBlksReadDelta, idxBlksHitDelta
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
                                   Long totalTxns, Long totalBytes) {
        jdbc.update("""
            insert into fact.pg_replication_slot_snapshot (
              sample_ts, instance_pk, slot_name, plugin, slot_type, database,
              active, active_pid, xmin_int, catalog_xmin_int, restart_lsn,
              confirmed_flush_lsn, wal_status, safe_wal_size, slot_lag_bytes,
              spill_txns, spill_count, spill_bytes,
              stream_txns, stream_count, stream_bytes,
              total_txns, total_bytes
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict do nothing
            """,
            sampleTs, instancePk, slotName, plugin, slotType, database,
            active, activePid, xmin, catalogXmin, restartLsn,
            confirmedFlushLsn, walStatus, safeWalSize, slotLagBytes,
            spillTxns, spillCount, spillBytes,
            streamTxns, streamCount, streamBytes,
            totalTxns, totalBytes
        );
    }

    // -------------------------------------------------------------------------
    // fact.pg_database_conflict_snapshot
    // -------------------------------------------------------------------------

    public void insertConflictSnapshot(OffsetDateTime sampleTs, long instancePk,
                                       String datname, Long conflTablespace,
                                       Long conflLock, Long conflSnapshot,
                                       Long conflBufferpin, Long conflDeadlock) {
        jdbc.update("""
            insert into fact.pg_database_conflict_snapshot (
              sample_ts, instance_pk, datname,
              confl_tablespace, confl_lock, confl_snapshot, confl_bufferpin, confl_deadlock
            )
            values (?, ?, ?, ?, ?, ?, ?, ?)
            on conflict do nothing
            """,
            sampleTs, instancePk, datname, conflTablespace,
            conflLock, conflSnapshot, conflBufferpin, conflDeadlock
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
                                           Long syncErrorCount, OffsetDateTime statsReset) {
        jdbc.update("""
            insert into fact.pg_subscription_snapshot (
              sample_ts, instance_pk, subid, subname, pid, relid,
              received_lsn, last_msg_send_time, last_msg_receipt_time,
              latest_end_lsn, latest_end_time, lag_bytes,
              apply_error_count, sync_error_count, stats_reset
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict do nothing
            """,
            sampleTs, instancePk, subid, subname, pid, relid,
            receivedLsn, lastMsgSendTime, lastMsgReceiptTime,
            latestEndLsn, latestEndTime, lagBytes,
            applyErrorCount, syncErrorCount, statsReset
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
}
