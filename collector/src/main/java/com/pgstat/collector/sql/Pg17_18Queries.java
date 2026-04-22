package com.pgstat.collector.sql;

/**
 * PG17 ve PG18 icin kaynak sorgulari.
 * pg14_16 uzerine eklenenler:
 * - pg_stat_checkpointer ayri view olarak gelir
 * - pg_stat_bgwriter'dan checkpoint kolonlari kaldirilmistir
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
}
