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
import java.util.Arrays;

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
                connections, null, null, null, null, resolver,
                new com.pgstat.collector.telemetry.PgssCapabilityCatalog(), null, null);
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

    @Test
    void theHighestExtensionVersionWinsRatherThanTheFirstDatabaseAlphabetically() throws Exception {
        // pgss extension surumu VERITABANI BASINADIR: ayni sunucuda appdb'de
        // 1.9, zebra'da 1.11 olabilir cunku biri guncellenmis digeri degil.
        // Veri kume geneli oldugu icin hangisinden okudugumuz VERIYI
        // degistirmez, ama HANGI KOLONLARI gorebildigimizi degistirir —
        // 1.9'dan okumak toplevel, jit_* ve stats_since'i, ayni sunucuda
        // mevcut olmalarina ragmen kaybettirir.
        Harness h = new Harness("postgres", "appdb", "zebra");
        h.withExtension("appdb", "public", "1.9");
        h.withExtension("zebra", "public", "1.11");

        DiscoveryCollector.PgssDiscovery result = h.scan();

        assertThat(result.databaseName()).isEqualTo("zebra");
        assertThat(result.extension().extVersion()).isEqualTo("1.11");
    }

    @Test
    void anUnparseableVersionLosesToAKnownOne() throws Exception {
        // Okunabilir ama surumu bilinmeyen bir kurulum, surumu bilinen birine
        // tercih edilmemeli: bilinmeyen surum savunmaci projection'a duser ve
        // kolonlarin bir kismi varsayilana iner.
        Harness h = new Harness("postgres", "appdb", "zebra");
        h.withExtension("appdb", "public", "garip");
        h.withExtension("zebra", "public", "1.10");

        assertThat(h.scan().databaseName()).isEqualTo("zebra");
    }

    @Test
    void aMultiDatabaseInstanceWithoutPgssAnywhereScansAllAndReportsNotInstalled() throws Exception {
        // Cok veritabanli bir instance'ta pgss hicbir yerde yoksa tarama tum
        // adaylari dener, catlamaz ve durumu not_installed olarak bildirir.
        // Bu yolun maliyeti aday sayisi kadar baglantidir; bootstrap geri
        // cekilmesi (1dk -> 5dk -> 15dk) tekrarini sinirlar.
        Harness h = new Harness("postgres", "a_db", "b_db", "c_db", "d_db");

        DiscoveryCollector.PgssDiscovery result = h.scan();

        assertThat(result.available()).isFalse();
        assertThat(DiscoveryCollector.pgssStatus(result.extension(),
                result.permissionDenied(), result.collectionFailed())).isEqualTo("not_installed");
        for (String db : new String[]{"a_db", "b_db", "c_db", "d_db"}) {
            verify(h.connections).connect(h.instance, db);
        }
    }

    @Test
    void theScanStopsOnceTheHighestKnownVersionIsFound() throws Exception {
        // Katalogun bildigi en yuksek surum bulunduysa daha iyisi zaten
        // okunamaz; kalan adaylara baglanmak bos maliyet olur.
        Harness h = new Harness("postgres", "appdb", "zebra");
        h.withExtension("appdb", "public", "1.12");
        h.withExtension("zebra", "public", "1.12");

        assertThat(h.scan().databaseName()).isEqualTo("appdb");
        verify(h.connections, org.mockito.Mockito.never()).connect(h.instance, "zebra");
    }

    /** Veritabani taramasi senaryolari icin ortak kurulum. */
    private static final class Harness {
        final SourceConnectionFactory connections = mock(SourceConnectionFactory.class);
        final PgStatStatementsExtensionResolver resolver = mock(PgStatStatementsExtensionResolver.class);
        final SourceQueries queries = mock(SourceQueries.class);
        final Connection admin = mock(Connection.class);
        final InstanceInfo instance = new InstanceInfo(7L, "db1", "host", 5432, "postgres",
                "secret", "prefer", "discovering", "collector", 5, 5000, 1000,
                100, 60, 60, 60, null, null);
        private final String adminDbname;

        Harness(String adminDbname, String... otherDatabases) throws Exception {
            this.adminDbname = adminDbname;
            Statement listStatement = mock(Statement.class);
            ResultSet rows = mock(ResultSet.class);

            when(resolver.resolve(admin)).thenReturn(null);   // admin DB'de yok
            when(queries.databaseListQuery()).thenReturn("database-list");
            when(admin.createStatement()).thenReturn(listStatement);
            when(listStatement.executeQuery("database-list")).thenReturn(rows);

            Boolean[] more = new Boolean[otherDatabases.length + 1];
            Arrays.fill(more, 0, otherDatabases.length + 1, Boolean.TRUE);
            more[otherDatabases.length] = Boolean.FALSE;
            when(rows.next()).thenReturn(Boolean.TRUE, more);

            String[] names = new String[otherDatabases.length];
            System.arraycopy(otherDatabases, 0, names, 0, otherDatabases.length);
            when(rows.getString("datname")).thenReturn(adminDbname, names);

            for (String db : otherDatabases) {
                Connection c = mock(Connection.class);
                candidates.put(db, c);
                when(connections.connect(instance, db)).thenReturn(c);
                when(resolver.resolve(c)).thenReturn(null);   // varsayilan: kurulu degil
            }
        }

        /**
         * Aday baglantilari burada tutulur. withExtension icinde
         * connections.connect(...) cagirmak mock'a CAGRI KAYDEDER ve "bu DB'ye
         * hic baglanilmadi" dogrulamasini yanlis yere dusururdu.
         */
        private final java.util.Map<String, Connection> candidates = new java.util.HashMap<>();

        void withExtension(String dbname, String schema, String version) throws Exception {
            Connection c = candidates.get(dbname);
            Statement probe = mock(Statement.class);
            when(c.createStatement()).thenReturn(probe);
            when(probe.executeQuery(contains("pg_stat_statements"))).thenReturn(mock(ResultSet.class));
            when(resolver.resolve(c)).thenReturn(
                    new PgStatStatementsExtensionResolver.PgStatStatementsExtension(schema, version));
        }

        DiscoveryCollector.PgssDiscovery scan() throws Exception {
            return new DiscoveryCollector(connections, null, null, null, null, resolver,
                    new com.pgstat.collector.telemetry.PgssCapabilityCatalog(), null, null)
                    .discoverPgssAcrossDatabases(instance, admin, queries, adminDbname);
        }
    }
}
