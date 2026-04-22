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

        Connection conn = DriverManager.getConnection(url, props);

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
     * Session-level timeout'lari set eder.
     * Kaynak PG uzerinde uzun sureli sorgu veya kilit beklemeyi onler.
     */
    private void configureSession(Connection conn, int statementTimeoutMs,
                                  int lockTimeoutMs) throws SQLException {
        try (Statement stmt = conn.createStatement()) {
            stmt.execute("SET statement_timeout = " + statementTimeoutMs);
            stmt.execute("SET lock_timeout = " + lockTimeoutMs);
        }
    }
}
