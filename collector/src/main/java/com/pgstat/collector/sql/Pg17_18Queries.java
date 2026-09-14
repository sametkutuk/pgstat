package com.pgstat.collector.sql;

/**
 * PG17 ve PG18 icin kaynak sorgulari.
 * pg14_16 uzerine eklenenler:
 * - pg_stat_checkpointer ayri view olarak gelir
 * - pg_stat_bgwriter'dan checkpoint kolonlari kaldirilmistir
 * - pg_stat_statements I/O timing kolonlari shared/local/temp olarak ayrilmistir
 */
public class Pg17_18Queries extends Pg14_16Queries {

    @Override
    public String familyCode() {
        return "pg17_18";
    }

    // =========================================================================
    // Cluster — bgwriter'dan checkpoint kolonlari ayrildi
    // =========================================================================

    @Override
    public String bgwriterQuery() {
        // PG17+: checkpoint_* kolonlari pg_stat_bgwriter'dan kaldirildi
        return """
            select
              buffers_clean,
              maxwritten_clean,
              buffers_alloc,
              stats_reset
            from pg_stat_bgwriter
            """;
    }

    @Override
    public String checkpointerQuery() {
        // PG17+: pg_stat_checkpointer ayri view
        // PG18+: num_done, slru_written eklendi — to_jsonb safe-lookup
        return """
            with src as (
              select to_jsonb(s.*) as j, s.* from pg_stat_checkpointer s
            )
            select
              num_timed as checkpoints_timed,
              num_requested as checkpoints_req,
              write_time as checkpoint_write_time,
              sync_time as checkpoint_sync_time,
              buffers_written as buffers_checkpoint,
              restartpoints_timed,
              restartpoints_req,
              restartpoints_done,
              coalesce((j->>'num_done')::bigint, 0) as num_done,
              coalesce((j->>'slru_written')::bigint, 0) as slru_written,
              stats_reset
            from src
            """;
    }

    // PG18: pg_stat_wal'dan wal_write/sync/write_time/sync_time kaldirildi
    @Override
    public String walQuery() {
        return """
            with src as (
              select to_jsonb(s.*) as j, s.* from pg_stat_wal s
            )
            select
              wal_records,
              wal_fpi,
              wal_bytes,
              coalesce((j->>'wal_buffers_full')::bigint, 0) as wal_buffers_full,
              coalesce((j->>'wal_write')::bigint, 0)        as wal_write,
              coalesce((j->>'wal_sync')::bigint, 0)         as wal_sync,
              coalesce((j->>'wal_write_time')::double precision, 0) as wal_write_time,
              coalesce((j->>'wal_sync_time')::double precision, 0)  as wal_sync_time,
              (j->>'stats_reset')::timestamptz as stats_reset
            from src
            """;
    }

    // PG17+ subscription: leader_pid + worker_type + conflict kolonlari
    @Override
    public String subscriptionQuery() {
        return """
            with sub_src as (
              select to_jsonb(s.*) as j, s.* from pg_stat_subscription s
            ),
            stats_src as (
              select to_jsonb(ss.*) as j, ss.* from pg_stat_subscription_stats ss
            )
            select
              s.subid::bigint                    as subid,
              s.subname,
              s.pid,
              s.relid::bigint                    as relid,
              s.received_lsn::text               as received_lsn,
              s.last_msg_send_time,
              s.last_msg_receipt_time,
              s.latest_end_lsn::text             as latest_end_lsn,
              s.latest_end_time,
              case when s.received_lsn is null or s.latest_end_lsn is null
                then null
                else (s.received_lsn - s.latest_end_lsn)::bigint
              end as lag_bytes,
              ss.apply_error_count,
              ss.sync_error_count,
              ss.stats_reset,
              s.leader_pid,
              coalesce(sub_src.j->>'worker_type', 'apply') as worker_type,
              coalesce((stats_src.j->>'confl_insert_exists')::bigint, 0) as confl_insert_exists,
              coalesce((stats_src.j->>'confl_update_origin_differs')::bigint, 0) as confl_update_origin_differs,
              coalesce((stats_src.j->>'confl_update_exists')::bigint, 0) as confl_update_exists,
              coalesce((stats_src.j->>'confl_update_missing')::bigint, 0) as confl_update_missing,
              coalesce((stats_src.j->>'confl_delete_origin_differs')::bigint, 0) as confl_delete_origin_differs,
              coalesce((stats_src.j->>'confl_delete_missing')::bigint, 0) as confl_delete_missing,
              coalesce((stats_src.j->>'confl_multiple_unique_conflicts')::bigint, 0) as confl_multiple_unique_conflicts
            from pg_stat_subscription s
            join sub_src on sub_src.subid = s.subid
            left join pg_stat_subscription_stats ss on ss.subid = s.subid
            left join stats_src on stats_src.subid = s.subid
            """;
    }

}
