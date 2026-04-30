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
              buffers_alloc
            from pg_stat_bgwriter
            """;
    }

    @Override
    public String checkpointerQuery() {
        // PG17+: pg_stat_checkpointer ayri view
        return """
            select
              num_timed as checkpoints_timed,
              num_requested as checkpoints_req,
              write_time as checkpoint_write_time,
              sync_time as checkpoint_sync_time,
              buffers_written as buffers_checkpoint
            from pg_stat_checkpointer
            """;
    }

    @Override
    public String pgssStatsQuery(String pgssFunction) {
        // PG17+: blk_*_time kolonlari shared/local/temp olarak ayrildi.
        // Merkezi model eski toplam alanlari bekledigi icin burada toplam alias donuyoruz.
        return """
            select
              userid, dbid, queryid,
              toplevel,
              calls,
              plans,
              total_plan_time,
              total_exec_time,
              rows,
              shared_blks_hit, shared_blks_read,
              shared_blks_dirtied, shared_blks_written,
              local_blks_hit, local_blks_read,
              local_blks_dirtied, local_blks_written,
              temp_blks_read, temp_blks_written,
              coalesce(shared_blk_read_time, 0)
                + coalesce(local_blk_read_time, 0)
                + coalesce(temp_blk_read_time, 0) as blk_read_time,
              coalesce(shared_blk_write_time, 0)
                + coalesce(local_blk_write_time, 0)
                + coalesce(temp_blk_write_time, 0) as blk_write_time,
              wal_records, wal_fpi, wal_bytes,
              jit_generation_time,
              jit_inlining_time,
              jit_optimization_time,
              jit_emission_time
            from %s(false)
            """.formatted(pgssFunction);
    }
}
