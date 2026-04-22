package com.pgstat.collector.repository;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.time.OffsetDateTime;

/**
 * instance_state + database_state guncelleme islemleri.
 * Mimari dok: satir 3779-3820
 */
@Repository
public class StateRepository {

    private final JdbcTemplate jdbc;

    public StateRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    // -------------------------------------------------------------------------
    // instance_state — ilk olusturma (bootstrap discovering adimi)
    // -------------------------------------------------------------------------

    /** Bootstrap sirasinda instance_state satirini olusturur (henuz yoksa). */
    public void initializeInstanceState(long instancePk) {
        jdbc.update("""
            insert into control.instance_state (instance_pk)
            values (?)
            on conflict (instance_pk) do nothing
            """,
            instancePk
        );
    }

    // -------------------------------------------------------------------------
    // Basarili toplama sonrasi guncelleme
    // -------------------------------------------------------------------------

    /**
     * Basarili cluster/statements toplama sonrasi state'i gunceller.
     *
     * @param now                   toplama zamani
     * @param clusterCollected      cluster toplama yapildi mi?
     * @param statementsCollected   statements toplama yapildi mi?
     * @param clusterIntervalSecs   bir sonraki cluster icin bekleme suresi
     * @param statementsIntervalSecs bir sonraki statements icin bekleme suresi
     * @param bootstrapCompleted    bootstrap tamamlandi mi? (ilk ready gecisi)
     * @param pgssEpochKey          guncel pgss epoch key (null ise guncellenmez)
     * @param instancePk            hedef instance
     */
    public void updateAfterSuccess(OffsetDateTime now, boolean clusterCollected,
                                   boolean statementsCollected, int clusterIntervalSecs,
                                   int statementsIntervalSecs, boolean bootstrapCompleted,
                                   String pgssEpochKey, long instancePk) {
        jdbc.update("""
            update control.instance_state s
            set last_cluster_collect_at = case when ? then ? else s.last_cluster_collect_at end,
                last_statements_collect_at = case when ? then ? else s.last_statements_collect_at end,
                next_cluster_collect_at = case when ? then ? + make_interval(secs => ?) else s.next_cluster_collect_at end,
                next_statements_collect_at = case when ? then ? + make_interval(secs => ?) else s.next_statements_collect_at end,
                bootstrap_completed_at = case
                  when ? and s.bootstrap_completed_at is null then ?
                  else s.bootstrap_completed_at
                end,
                current_pgss_epoch_key = coalesce(?, s.current_pgss_epoch_key),
                consecutive_failures = 0,
                backoff_until = null,
                last_success_at = ?
            where s.instance_pk = ?
            """,
            clusterCollected, now,
            statementsCollected, now,
            clusterCollected, now, clusterIntervalSecs,
            statementsCollected, now, statementsIntervalSecs,
            bootstrapCompleted, now,
            pgssEpochKey,
            now,
            instancePk
        );
    }

    // -------------------------------------------------------------------------
    // Hata sonrasi backoff
    // -------------------------------------------------------------------------

    /** Hata durumunda exponential backoff uygular (30s - 900s arasi). */
    public void updateAfterFailure(long instancePk, String errorMessage) {
        jdbc.update("""
            update control.instance_state s
            set consecutive_failures = s.consecutive_failures + 1,
                backoff_until = now() + make_interval(
                  secs => least(900, greatest(30, (2 ^ least(s.consecutive_failures, 9))::integer))
                ),
                next_cluster_collect_at = greatest(
                  coalesce(s.next_cluster_collect_at, now()), now()
                ),
                next_statements_collect_at = greatest(
                  coalesce(s.next_statements_collect_at, now()), now()
                ),
                last_error = ?,
                last_error_at = now()
            where s.instance_pk = ?
            """,
            errorMessage,
            instancePk
        );
    }

    /** Hata durumunda (mesajsiz) backoff uygular. */
    public void updateAfterFailure(long instancePk) {
        updateAfterFailure(instancePk, null);
    }

    /** Sadece last_error kaydeder — satir yoksa olusturur (discovery oncesi hata icin). */
    public void updateLastError(long instancePk, String errorMessage) {
        jdbc.update("""
            insert into control.instance_state (instance_pk, last_error, last_error_at)
            values (?, ?, now())
            on conflict (instance_pk) do update
              set last_error = excluded.last_error,
                  last_error_at = excluded.last_error_at
            """,
            instancePk,
            errorMessage
        );
    }

    // -------------------------------------------------------------------------
    // Rollup sonrasi toplu guncelleme
    // -------------------------------------------------------------------------

    /** Rollup job basarili olunca tum aktif instance'lar icin last_rollup_at gunceller. */
    public void updateRollupTimestamp() {
        jdbc.update("""
            update control.instance_state
            set last_rollup_at = now()
            where instance_pk in (
              select instance_pk from control.instance_inventory where is_active
            )
            """);
    }

    // -------------------------------------------------------------------------
    // database_state islemleri
    // -------------------------------------------------------------------------

    /** Yeni database kesfedildiginde database_state satiri olusturur. */
    public void upsertDatabaseState(long instancePk, long dbid) {
        jdbc.update("""
            insert into control.database_state (instance_pk, dbid)
            values (?, ?)
            on conflict (instance_pk, dbid) do nothing
            """,
            instancePk, dbid
        );
    }

    /** db_objects toplama sonrasi next zamani gunceller. */
    public void updateDatabaseStateAfterSuccess(long instancePk, long dbid,
                                                int intervalSeconds) {
        jdbc.update("""
            update control.database_state
            set last_db_objects_collect_at = now(),
                next_db_objects_collect_at = now() + make_interval(secs => ?),
                consecutive_failures = 0,
                backoff_until = null
            where instance_pk = ? and dbid = ?
            """,
            intervalSeconds, instancePk, dbid
        );
    }

    /** db_objects toplama hatasi sonrasi backoff uygular. */
    public void updateDatabaseStateAfterFailure(long instancePk, long dbid) {
        jdbc.update("""
            update control.database_state
            set consecutive_failures = consecutive_failures + 1,
                backoff_until = now() + make_interval(
                  secs => least(900, greatest(30, (2 ^ least(consecutive_failures, 9))::integer))
                )
            where instance_pk = ? and dbid = ?
            """,
            instancePk, dbid
        );
    }

    /** pgss_epoch_key degerini okur (delta karsilastirmasi icin). */
    public String findCurrentPgssEpochKey(long instancePk) {
        return jdbc.queryForObject("""
            select current_pgss_epoch_key
            from control.instance_state
            where instance_pk = ?
            """,
            String.class,
            instancePk
        );
    }
}
