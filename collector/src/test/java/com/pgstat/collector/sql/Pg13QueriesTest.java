package com.pgstat.collector.sql;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class Pg13QueriesTest {

    @Test
    void pgssStatsQueryDoesNotReferencePg14OrPg15OnlyColumns() {
        String sql = new Pg13Queries().pgssStatsQuery("custom_schema.pg_stat_statements");

        assertThat(sql).contains("from custom_schema.pg_stat_statements(false)");
        assertThat(sql).contains("null::boolean as toplevel");
        assertThat(sql).contains("plans");
        assertThat(sql).contains("total_plan_time");
        assertThat(sql).contains("0::double precision as jit_generation_time");
        assertThat(sql).doesNotContain("\n              toplevel,\n");
        assertThat(sql).doesNotContain("\n              jit_generation_time,\n");
    }
}
