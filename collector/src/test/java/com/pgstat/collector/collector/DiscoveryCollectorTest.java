package com.pgstat.collector.collector;

import org.junit.jupiter.api.Test;

import java.sql.SQLException;

import static org.assertj.core.api.Assertions.assertThat;

class DiscoveryCollectorTest {

    private final DiscoveryCollector collector = new DiscoveryCollector(
            null, null, null, null, null, null);

    @Test
    void buildErrorDetailDistinguishesPgHbaFailureFromBadPassword() {
        SQLException error = new SQLException(
                "FATAL: no pg_hba.conf entry for host \"10.0.0.5\", user \"pgstats_collector\", database \"postgres\", no encryption",
                "28000");

        String detail = collector.buildErrorDetail(error);

        assertThat(detail).contains("pg_hba.conf erisim hatasi");
        assertThat(detail).contains("host/kullanici/database/SSL");
        assertThat(detail).doesNotContain("sifre yanlis");
    }

    @Test
    void buildErrorDetailStillReportsInvalidPasswordAsAuthenticationFailure() {
        SQLException error = new SQLException(
                "FATAL: password authentication failed for user \"pgstats_collector\"",
                "28P01");

        String detail = collector.buildErrorDetail(error);

        assertThat(detail).contains("Kimlik");
        assertThat(detail).contains("SQLState: 28P01");
        assertThat(detail).doesNotContain("pg_hba.conf erisim hatasi");
    }
}
