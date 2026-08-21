package com.pgstat.collector.service;

import com.pgstat.collector.model.InstanceInfo;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.Properties;

/**
 * Kaynak PostgreSQL instance'larina ephemeral JDBC baglantisi olusturur.
 *
 * Tasarim kararlari:
 * - Baglanti havuzu KULLANILMAZ — her toplama dongusunde yeni baglanti acilir, hemen kapatilir.
 * - Her baglantida application_name set edilir (izlenebilirlik).
 * - statement_timeout ve lock_timeout schedule_profile'dan alinir.
 * - connect_timeout JDBC URL parametresi olarak verilir.
 * - Sifre SecretResolver uzerinden cozumlenir.
 */
@Service
public class SourceConnectionFactory {

    private static final Logger log = LoggerFactory.getLogger(SourceConnectionFactory.class);

    /** Kaynak PG'lerde gorunecek uygulama adi */
    private static final String APPLICATION_NAME = "pgstat_collector";
    private static final int MAX_RETRY = 1;
    private static final long RETRY_DELAY_MS = 5_000L;

    // pg_stat_statements(false) set-returning function'i, cok sayida tracked
    // statement'li instance'larda (musteri raporu 2026-08-21: 4758 satir) kendi
    // materialization'inda instance'in varsayilan work_mem'ini (2-4MB) asip temp
    // file'a dokuluyor — sorgu WHERE ile filtrelenemez (tum satirlar toplanmali),
    // bu yuzden collector'in kendi session'inda work_mem'i yukseltiyoruz. Instance'in
    // kalici ayarini degistirmez, sadece bu ephemeral baglanti icin gecerli.
    private static final int SOURCE_SESSION_WORK_MEM_MB = 32;

    private final SecretResolver secretResolver;

    public SourceConnectionFactory(SecretResolver secretResolver) {
        this.secretResolver = secretResolver;
    }

    /**
     * Kaynak instance'a admin_dbname uzerinden baglanti acar.
     * Caller, kullanim bittikten sonra Connection'i kapatmakla yukumludur.
     *
     * @param instance hedef instance bilgileri
     * @return acik JDBC baglantisi
     * @throws SQLException baglanti kurulamadiysa
     * @throws SecretResolver.SecretResolveException sifre cozumlenemezse
     */
    public Connection connect(InstanceInfo instance) throws SQLException {
        return connect(instance, instance.adminDbname());
    }

    /**
     * Kaynak instance'a belirtilen veritabanina baglanti acar.
     * db_objects toplama icin farkli database'lere baglanmak gerektiginde kullanilir.
     *
     * @param instance hedef instance bilgileri
     * @param dbname   baglanilacak veritabani adi
     * @return acik JDBC baglantisi
     * @throws SQLException baglanti kurulamadiysa
     * @throws SecretResolver.SecretResolveException sifre cozumlenemezse
     */
    public Connection connect(InstanceInfo instance, String dbname) throws SQLException {
        // secret_ref'ten sifreyi cozumle
        String password = secretResolver.resolve(instance.secretRef());

        // JDBC URL olustur — connect_timeout dahil
        String url = buildUrl(instance.host(), instance.port(), dbname,
                instance.connectTimeoutSeconds(), instance.sslMode());

        // Baglanti ozellikleri
        Properties props = new Properties();
        props.setProperty("user", instance.collectorUsername() != null
                ? instance.collectorUsername() : "pgstats_collector");
        props.setProperty("password", password);
        props.setProperty("ApplicationName", APPLICATION_NAME);

        // SSL root cert path (verify-ca/verify-full icin gerekli)
        // Not: instance_inventory'de ssl_root_cert_path varsa burada set edilmeli
        // V1'de ssl_mode='prefer' varsayilan oldugu icin genellikle gerekmez

        log.debug("Baglanti aciliyor: {}:{}/{} (ssl={})",
                instance.host(), instance.port(), dbname, instance.sslMode());

        Connection conn = openWithRetry(url, props, instance);

        // Session-level timeout'lari ayarla
        configureSession(conn, instance.statementTimeoutMs(), instance.lockTimeoutMs());

        return conn;
    }

    /**
     * JDBC URL olusturur.
     * PostgreSQL JDBC surucusu parametreleri:
     *   connectTimeout — saniye cinsinden baglanti zaman asimi
     *   sslmode — disable/allow/prefer/require/verify-ca/verify-full
     */
    private String buildUrl(String host, int port, String dbname,
                            int connectTimeoutSeconds, String sslMode) {
        return String.format(
                "jdbc:postgresql://%s:%d/%s?connectTimeout=%d&sslmode=%s",
                host, port, dbname, connectTimeoutSeconds, sslMode
        );
    }

    /**
     * Sadece connection acma sirasindaki transient network hatalarinda retry yapar.
     * Authentication/configuration hatalari retry edilmez.
     */
    private Connection openWithRetry(String url, Properties props, InstanceInfo instance) throws SQLException {
        SQLException lastError = null;

        for (int attempt = 0; attempt <= MAX_RETRY; attempt++) {
            try {
                return DriverManager.getConnection(url, props);
            } catch (SQLException e) {
                lastError = e;
                if (attempt < MAX_RETRY && isTransientConnectionError(e)) {
                    log.warn("Connection failed for instance pk={} (attempt {}/{}), retry in {}ms: {}",
                        instance.instancePk(), attempt + 1, MAX_RETRY + 1, RETRY_DELAY_MS, e.getMessage());
                    sleepBeforeRetry();
                } else {
                    throw e;
                }
            }
        }

        if (lastError != null) {
            throw lastError;
        }
        throw new SQLException("Connection retry failed without SQLException");
    }

    private void sleepBeforeRetry() throws SQLException {
        try {
            Thread.sleep(RETRY_DELAY_MS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new SQLException("Interrupted while waiting to retry", e);
        }
    }

    private boolean isTransientConnectionError(SQLException e) {
        String state = e.getSQLState();
        if (state != null && state.startsWith("28")) {
            return false;
        }
        if (state != null && state.startsWith("08")) {
            return true;
        }

        Throwable cur = e;
        while (cur != null) {
            String msg = cur.getMessage();
            if (msg != null) {
                String lower = msg.toLowerCase();
                if (lower.contains("connection attempt failed")
                        || lower.contains("connection refused")
                        || lower.contains("connection reset")
                        || lower.contains("connection timed out")
                        || lower.contains("could not connect")
                        || lower.contains("no route to host")
                        || lower.contains("network is unreachable")) {
                    return true;
                }
            }
            cur = cur.getCause();
        }

        return false;
    }

    /**
     * Session-level timeout'lari set eder.
     * Kaynak PG uzerinde uzun sureli sorgu veya kilit beklemeyi onler.
     */
    private void configureSession(Connection conn, int statementTimeoutMs,
                                  int lockTimeoutMs) throws SQLException {
        // Değerler integer olarak doğrulanır — SQL injection riski yok
        int safeStatementTimeout = Math.max(0, Math.min(statementTimeoutMs, 3_600_000));
        int safeLockTimeout = Math.max(0, Math.min(lockTimeoutMs, 3_600_000));
        try (Statement stmt = conn.createStatement()) {
            stmt.execute(String.format("SET statement_timeout = %d", safeStatementTimeout));
            stmt.execute(String.format("SET lock_timeout = %d", safeLockTimeout));
            stmt.execute(String.format("SET work_mem = '%dMB'", SOURCE_SESSION_WORK_MEM_MB));
        }
    }
}
