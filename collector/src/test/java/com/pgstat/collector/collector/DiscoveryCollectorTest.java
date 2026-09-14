package com.pgstat.collector.collector;

import com.pgstat.collector.model.InstanceInfo;
import com.pgstat.collector.service.PgStatStatementsExtensionResolver;
import com.pgstat.collector.service.SourceConnectionFactory;
import com.pgstat.collector.sql.SourceQueries;
import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.contains;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class DiscoveryCollectorTest {

    private final DiscoveryCollector collector = new DiscoveryCollector(
            null, null, null, null, null, null, null, null, null);

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

    @Test
    void pgssStatusSeparatesAvailabilityUnknownVersionAbsenceAndPermission() {
        var available = new com.pgstat.collector.service.PgStatStatementsExtensionResolver
                .PgStatStatementsExtension("public", "1.11");
        var unknown = new com.pgstat.collector.service.PgStatStatementsExtensionResolver
                .PgStatStatementsExtension("public", "unexpected");

        assertThat(DiscoveryCollector.pgssStatus(available, false, false)).isEqualTo("available");
        assertThat(DiscoveryCollector.pgssStatus(unknown, false, false)).isEqualTo("version_unknown");
        assertThat(DiscoveryCollector.pgssStatus(null, false, false)).isEqualTo("not_installed");
        assertThat(DiscoveryCollector.pgssStatus(null, true, false)).isEqualTo("permission_denied");
        assertThat(DiscoveryCollector.pgssStatus(available, false, true)).isEqualTo("collection_failed");
    }

    @Test
    void discoverySelectsAnAccessibleNonAdminDatabaseWithoutCollectingEveryDatabase() throws Exception {
        SourceConnectionFactory connections = mock(SourceConnectionFactory.class);
        PgStatStatementsExtensionResolver resolver = mock(PgStatStatementsExtensionResolver.class);
        SourceQueries queries = mock(SourceQueries.class);
        Connection admin = mock(Connection.class);
        Connection app = mock(Connection.class);
        Statement listStatement = mock(Statement.class);
        Statement probeStatement = mock(Statement.class);
        ResultSet databaseRows = mock(ResultSet.class);
        ResultSet probeRows = mock(ResultSet.class);
        InstanceInfo instance = new InstanceInfo(7L, "db1", "host", 5432, "postgres",
                "secret", "prefer", "discovering", "collector", 5, 5000, 1000,
                100, 60, 60, 60, null, null);

        when(resolver.resolve(admin)).thenReturn(null);
        when(queries.databaseListQuery()).thenReturn("database-list");
        when(admin.createStatement()).thenReturn(listStatement);
        when(listStatement.executeQuery("database-list")).thenReturn(databaseRows);
        when(databaseRows.next()).thenReturn(true, true, true, false);
        when(databaseRows.getString("datname")).thenReturn("postgres", "blocked_db", "appdb");
        when(connections.connect(instance, "blocked_db"))
                .thenThrow(new SQLException("permission denied for database", "42501"));
        when(connections.connect(instance, "appdb")).thenReturn(app);
        var extension = new PgStatStatementsExtensionResolver.PgStatStatementsExtension("monitor", "1.11");
        when(resolver.resolve(app)).thenReturn(extension);
        when(app.createStatement()).thenReturn(probeStatement);
        when(probeStatement.executeQuery(contains("pg_stat_statements"))).thenReturn(probeRows);

        DiscoveryCollector collector = new DiscoveryCollector(
                connections, null, null, null, null, resolver, null, null, null);
        DiscoveryCollector.PgssDiscovery result = collector.discoverPgssAcrossDatabases(
                instance, admin, queries, "postgres");

        assertThat(result.available()).isTrue();
        assertThat(result.databaseName()).isEqualTo("appdb");
        assertThat(result.extension()).isEqualTo(extension);
        verify(connections).connect(instance, "blocked_db");
        verify(connections).connect(instance, "appdb");
        verify(probeStatement).executeQuery(
                "select 1 from \"monitor\".\"pg_stat_statements\"(false) limit 0");
    }
}
