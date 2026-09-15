package com.pgstat.collector.collector;

import com.pgstat.collector.model.InstanceInfo;
import com.pgstat.collector.service.PgStatStatementsExtensionResolver;
import com.pgstat.collector.service.SourceConnectionFactory;
import com.pgstat.collector.sql.Pg17_18Queries;
import com.pgstat.collector.telemetry.PgssCapabilityCatalog;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtensionContext;
import org.junit.jupiter.api.extension.RegisterExtension;
import org.junit.jupiter.api.extension.TestWatcher;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.DockerClientFactory;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * PGSTAT-P1-021 / AC7 — gercek PostgreSQL ve bundled pgss surum matrisi.
 *
 * Docker yoksa sinif JUnit tarafindan gorunur bicimde SKIPPED olur. Docker
 * varsa kodun URETTIGI sorgu gercek extension'a karsi calisir; SQL metnini
 * birim testte karsilastirmak bu davranisi kanitlamaz.
 */
@Testcontainers
class PgssRealPostgresIT {

    private static final int EXPECTED_MATRIX_INVOCATIONS = 6;

    @RegisterExtension
    static final MatrixResultGuard MATRIX_RESULTS = new MatrixResultGuard();

    /**
     * Acik kapi degil, acik anahtar: gelistiricide Docker yoksa gorunur skip;
     * PGSTAT_REQUIRE_DOCKER=true olan CI/verify kosumunda ayni durum sert hata.
     * disabledWithoutDocker kullanilmaz: Testcontainers baslatma kusurlarini da
     * "Docker yok" diye sessizce skip ederek sahte yesil uretebiliyor.
     */
    @BeforeAll
    static void requireDocker() {
        String detail;
        try {
            if (DockerClientFactory.instance().isDockerAvailable()) return;
            detail = "isDockerAvailable() == false";
        } catch (Throwable error) {
            detail = error.toString();
        }
        if (Boolean.parseBoolean(System.getenv("PGSTAT_REQUIRE_DOCKER"))) {
            throw new IllegalStateException(
                    "PGSTAT_REQUIRE_DOCKER=true ama Docker ortami yok: " + detail);
        }
        Assumptions.abort("Docker yok, pgss gercek-DB matrisi atlandi: " + detail);
    }

    @AfterAll
    static void requireCompleteMatrixInMandatoryRuns() {
        if (!Boolean.parseBoolean(System.getenv("PGSTAT_REQUIRE_DOCKER"))) return;
        assertThat(MATRIX_RESULTS.aborted.get()).as("atlanan pgss matrisi invocation sayisi").isZero();
        assertThat(MATRIX_RESULTS.succeeded.get()).as("tamamlanan pgss matrisi invocation sayisi")
                .isEqualTo(EXPECTED_MATRIX_INVOCATIONS);
    }

    private final PgssCapabilityCatalog catalog = new PgssCapabilityCatalog();
    private final PgStatStatementsExtensionResolver resolver =
            new PgStatStatementsExtensionResolver();

    static Stream<Arguments> bundledVersionMatrix() {
        return Stream.of(
                Arguments.of("postgres:13", "1.8"),
                Arguments.of("postgres:14", "1.9"),
                Arguments.of("postgres:15", "1.10"),
                Arguments.of("postgres:18", "1.12")
        );
    }

    @ParameterizedTest(name = "{0} bundles pgss {1} and runs its generated projection")
    @MethodSource("bundledVersionMatrix")
    void generatedProjectionRunsAgainstTheMeasuredExtensionVersion(
            String image, String expectedPgssVersion) throws Exception {
        try (PostgreSQLContainer<?> postgres = postgres(image)) {
            postgres.start();
            try (Connection connection = connect(postgres, "postgres")) {
                execute(connection, "create extension pg_stat_statements");
                var extension = resolver.resolve(connection);

                assertThat(extension).isNotNull();
                assertThat(extension.extVersion()).isEqualTo(expectedPgssVersion);
                assertThat(catalog.buildStatsQuery(
                        extension.qualify("pg_stat_statements"),
                        PgssCapabilityCatalog.PgssVersion.of(extension.extVersion())))
                        .doesNotContain("to_jsonb(s.*)");

                try (var statement = connection.createStatement();
                     var rows = statement.executeQuery(catalog.buildStatsQuery(
                             extension.qualify("pg_stat_statements"),
                             PgssCapabilityCatalog.PgssVersion.of(extension.extVersion())))) {
                    assertThat(rows.next()).isTrue();
                }
            }
        }
    }

    @Test
    void discoveryFindsPgssWhenItExistsOnlyInAppDatabase() throws Exception {
        try (PostgreSQLContainer<?> postgres = postgres("postgres:18")) {
            postgres.start();
            try (Connection admin = connect(postgres, "postgres")) {
                execute(admin, "create database appdb");
            }
            try (Connection app = connect(postgres, "appdb")) {
                execute(app, "create extension pg_stat_statements");
            }

            SourceConnectionFactory connections = mock(SourceConnectionFactory.class);
            InstanceInfo instance = instance(postgres, "postgres", postgres.getUsername());
            when(connections.connect(instance, "appdb"))
                    .thenAnswer(ignored -> connect(postgres, "appdb"));
            DiscoveryCollector collector = new DiscoveryCollector(
                    connections, null, null, null, null, resolver, catalog, null, null);

            try (Connection admin = connect(postgres, "postgres")) {
                DiscoveryCollector.PgssDiscovery found = collector.discoverPgssAcrossDatabases(
                        instance, admin, new Pg17_18Queries(), "postgres");
                assertThat(found.available()).isTrue();
                assertThat(found.databaseName()).isEqualTo("appdb");
                assertThat(found.extension().extVersion()).isEqualTo("1.12");
            }
        }
    }

    @Test
    void functionExecuteDenialProducesTheExpectedSqlState() throws Exception {
        try (PostgreSQLContainer<?> postgres = postgres("postgres:18")) {
            postgres.start();
            try (Connection admin = connect(postgres, "postgres")) {
                execute(admin, "create extension pg_stat_statements");
                execute(admin, "create role limited login password 'limited'");
                execute(admin, "grant connect on database postgres to limited");
                execute(admin, "revoke execute on function public.pg_stat_statements(boolean) from public");
            }

            try (Connection limited = DriverManager.getConnection(
                    jdbcUrl(postgres, "postgres"), "limited", "limited")) {
                var extension = resolver.resolve(limited);
                assertThat(extension).isNotNull();
                assertThatThrownBy(() -> {
                    try (var statement = limited.createStatement()) {
                        statement.executeQuery("select 1 from "
                                + extension.qualify("pg_stat_statements")
                                + "(false) limit 0");
                    }
                }).isInstanceOf(SQLException.class)
                  .extracting(error -> ((SQLException) error).getSQLState())
                  .isEqualTo("42501");
            }
        }
    }

    private static PostgreSQLContainer<?> postgres(String image) {
        return new PostgreSQLContainer<>(image)
                .withCommand("postgres", "-c", "shared_preload_libraries=pg_stat_statements");
    }

    private static Connection connect(PostgreSQLContainer<?> postgres, String database)
            throws SQLException {
        return DriverManager.getConnection(
                jdbcUrl(postgres, database), postgres.getUsername(), postgres.getPassword());
    }

    private static String jdbcUrl(PostgreSQLContainer<?> postgres, String database) {
        return postgres.getJdbcUrl().replace(
                "/" + postgres.getDatabaseName() + "?", "/" + database + "?");
    }

    private static InstanceInfo instance(PostgreSQLContainer<?> postgres, String adminDbname,
                                         String username) {
        return new InstanceInfo(1L, "pgss-matrix", postgres.getHost(),
                postgres.getMappedPort(PostgreSQLContainer.POSTGRESQL_PORT), adminDbname,
                "unused", "disable", "discovering", username,
                5, 30_000, 1_000, 100, 60, 60, 60, null, null);
    }

    private static void execute(Connection connection, String sql) throws SQLException {
        try (var statement = connection.createStatement()) {
            statement.execute(sql);
        }
    }

    static final class MatrixResultGuard implements TestWatcher {
        private final AtomicInteger succeeded = new AtomicInteger();
        private final AtomicInteger aborted = new AtomicInteger();

        @Override
        public void testSuccessful(ExtensionContext context) {
            succeeded.incrementAndGet();
        }

        @Override
        public void testAborted(ExtensionContext context, Throwable cause) {
            aborted.incrementAndGet();
        }
    }
}
