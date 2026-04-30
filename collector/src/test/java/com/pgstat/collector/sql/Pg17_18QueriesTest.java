package com.pgstat.collector.sql;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class Pg17_18QueriesTest {

    @Test
    void pgssStatsQueryAliasesPg17SplitIoTimingColumnsToLegacyNames() {
        String sql = new Pg17_18Queries().pgssStatsQuery("custom_schema.pg_stat_statements");

        assertThat(sql).contains("from custom_schema.pg_stat_statements(false)");
        assertThat(sql).contains("shared_blk_read_time");
        assertThat(sql).contains("local_blk_read_time");
        assertThat(sql).contains("temp_blk_read_time");
        assertThat(sql).contains("as blk_read_time");
        assertThat(sql).contains("shared_blk_write_time");
        assertThat(sql).contains("local_blk_write_time");
        assertThat(sql).contains("temp_blk_write_time");
        assertThat(sql).contains("as blk_write_time");
        assertThat(sql).doesNotContain("blk_read_time, blk_write_time");
    }
}
