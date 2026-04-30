package com.pgstat.collector.collector;

import com.pgstat.collector.model.InstanceCapability;
import com.pgstat.collector.model.InstanceInfo;
import com.pgstat.collector.repository.CapabilityRepository;
import com.pgstat.collector.repository.DimensionRepository;
import com.pgstat.collector.repository.StateRepository;
import com.pgstat.collector.service.PgStatStatementsExtensionResolver;
import com.pgstat.collector.service.PgStatStatementsExtensionResolver.PgStatStatementsExtension;
import com.pgstat.collector.service.SecretResolver;
import com.pgstat.collector.service.SqlFamilyResolver;
import com.pgstat.collector.service.SourceConnectionFactory;
import com.pgstat.collector.sql.SourceQueries;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.OffsetDateTime;
import java.util.Locale;

/**
 * Kaynak PostgreSQL instance'inin yeteneklerini kesfeder.
 *
 * Discovery adiminda yapilan isler:
 * 1. Kaynak PG'ye baglan
 * 2. server_version_num, pg_is_in_recovery(), system_identifier sorgula
 * 3. pg_major hesapla → collector_sql_family belirle
 * 4. pg_stat_statements extension kontrolu
 * 5. compute_query_id ayarini oku
 * 6. pg_postmaster_start_time() sorgula
 * 7. pg_stat_statements_info (PG14+) — son reset zamani
 * 8. control.instance_capability upsert
 * 9. Database listesini sorgula → dim.database_ref + control.database_state upsert
 * 10. control.instance_state satiri olustur (yoksa)
 */
@Component
public class DiscoveryCollector {

    private static final Logger log = LoggerFactory.getLogger(DiscoveryCollector.class);

    private final SourceConnectionFactory connectionFactory;
    private final SqlFamilyResolver familyResolver;
    private final CapabilityRepository capabilityRepo;
    private final StateRepository stateRepo;
    private final DimensionRepository dimensionRepo;
    private final PgStatStatementsExtensionResolver pgssResolver;

    public DiscoveryCollector(SourceConnectionFactory connectionFactory,
                              SqlFamilyResolver familyResolver,
                              CapabilityRepository capabilityRepo,
                              StateRepository stateRepo,
                              DimensionRepository dimensionRepo,
                              PgStatStatementsExtensionResolver pgssResolver) {
        this.connectionFactory = connectionFactory;
        this.familyResolver = familyResolver;
        this.capabilityRepo = capabilityRepo;
        this.stateRepo = stateRepo;
        this.dimensionRepo = dimensionRepo;
        this.pgssResolver = pgssResolver;
    }

    /**
     * Instance kesfini calistirir.
     *
     * @param instance hedef instance bilgileri
     * @return kesfedilen yetenekler; hata durumunda null
     */
    public InstanceCapability discover(InstanceInfo instance) {
        log.info("Discovery baslatiliyor: {} ({}:{})",
                instance.instanceId(), instance.host(), instance.port());

        try (Connection conn = connectionFactory.connect(instance)) {
            // 1. Temel bilgiler: version, recovery, system_identifier
            int serverVersionNum;
            boolean isInRecovery;
            long systemIdentifier;

            try (Statement stmt = conn.createStatement();
                 ResultSet rs = stmt.executeQuery(
                     "select current_setting('server_version_num')::integer as server_version_num, " +
                     "pg_is_in_recovery() as is_in_recovery, " +
                     "system_identifier from pg_control_system()")) {
                rs.next();
                serverVersionNum = rs.getInt("server_version_num");
                isInRecovery = rs.getBoolean("is_in_recovery");
                systemIdentifier = rs.getLong("system_identifier");
            }

            int pgMajor = SqlFamilyResolver.extractPgMajor(serverVersionNum);
            String sqlFamily = familyResolver.resolveFamilyCode(pgMajor);
            SourceQueries queries = familyResolver.resolve(pgMajor);

            log.info("Instance {}: PG{} ({}), primary={}, family={}",
                    instance.instanceId(), pgMajor, serverVersionNum,
                    !isInRecovery, sqlFamily);

            // 2. pg_stat_statements extension kontrolu
            // Oncelik: shared_preload_libraries'de var mi? (herhangi bir DB'den sorgulanabilir)
            // Extension farkli bir DB'de olabilir — admin_dbname'de olmasa bile calisiyor olabilir.
            boolean hasPgss = false;
            boolean hasPgssInfo = false;
            boolean hasPgStatIo = false;
            boolean hasPgStatCheckpointer = false;

            // Adim 1: shared_preload_libraries kontrolu (en guvenilir)
            boolean pgssInPreload = false;
            try (Statement stmt = conn.createStatement();
                 ResultSet rs = stmt.executeQuery("SHOW shared_preload_libraries")) {
                if (rs.next()) {
                    String libs = rs.getString(1);
                    pgssInPreload = libs != null && libs.contains("pg_stat_statements");
                }
            } catch (Exception e) {
                log.debug("shared_preload_libraries okunamadi: {}", e.getMessage());
            }

            // Adim 2: Admin DB'de extension var mi? Schema search_path'e bagli
            // olmadigi icin pg_extension'dan okunur ve sorgular schema-qualified calisir.
            PgStatStatementsExtension pgssExtension = pgssResolver.resolve(conn);
            hasPgss = pgssExtension != null;

            // Adim 3: Admin DB'de yok ama preload'da varsa baska DB'de olabilir.
            // Collector statements job'unda admin DB'ye baglanir; extension objeleri
            // admin DB'de queryable degilse ready kabul edilmemeli.
            if (!hasPgss && pgssInPreload) {
                log.warn("pg_stat_statements admin DB'de ({}) yok ama shared_preload_libraries'de var. " +
                         "Collector admin DB'de extension objelerini sorgulayamadigi icin degraded olacak.",
                         instance.adminDbname());
            }

            String pgssInfoRelation = pgssExtension != null
                    ? pgssExtension.qualify("pg_stat_statements_info") : null;

            // PG16+ icin pg_stat_io kontrolu — view yalnizca PG16'da eklendi
            hasPgStatIo = pgMajor >= 16;

            // PG17+ icin pg_stat_checkpointer kontrolu — view yalnizca PG17'de ayrildi
            hasPgStatCheckpointer = pgMajor >= 17;

            // 3. compute_query_id ayari
            String computeQueryIdMode = null;
            try (Statement stmt = conn.createStatement();
                 ResultSet rs = stmt.executeQuery(queries.computeQueryIdQuery())) {
                if (rs.next()) {
                    computeQueryIdMode = rs.getString("compute_query_id");
                }
            }

            // 4. Postmaster start time
            OffsetDateTime postmasterStartAt = null;
            try (Statement stmt = conn.createStatement();
                 ResultSet rs = stmt.executeQuery(queries.postmasterStartTimeQuery())) {
                if (rs.next()) {
                    postmasterStartAt = rs.getObject("start_time", OffsetDateTime.class);
                }
            }

            // 5. pgss stats reset zamani (PG14+)
            OffsetDateTime pgssStatsResetAt = null;
            if (queries.supportsPgssInfo() && hasPgss) {
                try (Statement stmt = conn.createStatement();
                     ResultSet rs = stmt.executeQuery(queries.pgssInfoQuery(pgssInfoRelation))) {
                    if (rs.next()) {
                        pgssStatsResetAt = rs.getObject("last_stats_reset", OffsetDateTime.class);
                        hasPgssInfo = true;
                    }
                } catch (Exception e) {
                    log.warn("pg_stat_statements_info okunamadi: instance={}, schema={}, hata={}",
                            instance.instanceId(),
                            pgssExtension != null ? pgssExtension.schemaName() : null,
                            e.getMessage());
                }
            }

            // 6. Capability olustur ve kaydet
            InstanceCapability capability = new InstanceCapability(
                instance.instancePk(),
                serverVersionNum,
                pgMajor,
                systemIdentifier,
                true,  // isReachable
                !isInRecovery,  // isPrimary
                hasPgss,
                hasPgssInfo,
                hasPgStatIo,
                hasPgStatCheckpointer,
                computeQueryIdMode,
                sqlFamily,
                postmasterStartAt,
                pgssStatsResetAt,
                OffsetDateTime.now(), // lastDiscoveredAt
                null, // lastErrorAt
                null  // lastErrorText
            );

            capabilityRepo.upsert(capability);

            // 7. instance_state satiri olustur (yoksa)
            stateRepo.initializeInstanceState(instance.instancePk());

            // 8. Database listesini kesfet
            discoverDatabases(conn, queries, instance.instancePk());

            log.info("Discovery tamamlandi: {} — PG{}, pgss={}, primary={}",
                    instance.instanceId(), pgMajor, hasPgss, !isInRecovery);

            return capability;

        } catch (SecretResolver.SecretResolveException e) {
            log.error("Secret cozumleme hatasi: {} — {}", instance.instanceId(), e.getMessage());
            capabilityRepo.markUnreachable(instance.instancePk(), e.getMessage());
            stateRepo.updateLastError(instance.instancePk(), "Secret hatası: " + e.getMessage());
            return null;

        } catch (Exception e) {
            String detail = buildErrorDetail(e);
            log.error("Discovery hatasi: {} — {}", instance.instanceId(), detail);
            capabilityRepo.markUnreachable(instance.instancePk(), detail);
            stateRepo.updateLastError(instance.instancePk(), detail);
            return null;
        }
    }

    /** Exception'dan anlaşılır hata mesajı üretir. */
    String buildErrorDetail(Exception e) {
        String msg = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
        Throwable cause = e.getCause();
        String causeMsg = cause != null && cause.getMessage() != null ? cause.getMessage() : null;
        String fullMsg = causeMsg != null ? msg + " - " + causeMsg : msg;
        String normalized = fullMsg.toLowerCase(Locale.ROOT);

        if (isPgHbaError(normalized)) {
            return "pg_hba.conf erisim hatasi - kaynak PostgreSQL bu host/kullanici/database/SSL kombinasyonuna izin vermiyor: "
                    + fullMsg;
        }

        // JDBC bağlantı hatalarının gerçek nedeni cause'da olur
        if (causeMsg != null) {
            // Bilinen hata kalıpları → Türkçe açıklama
            if (causeMsg.contains("Connection refused") || causeMsg.contains("connect refused")) {
                return "Bağlantı reddedildi — host/port yanlış veya PostgreSQL çalışmıyor (" + causeMsg + ")";
            }
            if (causeMsg.contains("timeout") || causeMsg.contains("timed out")) {
                return "Bağlantı zaman aşımı — host erişilemiyor veya firewall engelliyor (" + causeMsg + ")";
            }
            if (causeMsg.contains("No route to host") || causeMsg.contains("Network is unreachable")) {
                return "Host'a ulaşılamıyor — IP adresi yanlış veya ağ erişimi yok (" + causeMsg + ")";
            }
            return msg + " — " + causeMsg;
        }

        // JDBC SQLState bazlı hatalar (pg_hba, şifre vb.)
        if (e instanceof SQLException se) {
            String state = se.getSQLState();
            if ("28P01".equals(state)) {
                return "Kimlik doğrulama hatası — kullanıcı adı veya şifre yanlış (SQLState: " + state + ")";
            }
            if ("28000".equals(state)) {
                return "Kimlik dogrulama/pg_hba hatasi (SQLState: " + state + "): " + msg;
            }
            if ("3D000".equals(state)) {
                return "Veritabanı bulunamadı — admin_dbname yanlış (SQLState: " + state + ")";
            }
            if ("42501".equals(state)) {
                return "Yetki hatası — kullanıcının pg_monitor rolü yok (SQLState: " + state + ")";
            }
            if (state != null && state.startsWith("08")) {
                return "Bağlantı hatası (SQLState: " + state + ") — pg_hba.conf izni eksik olabilir: " + msg;
            }
        }

        return msg;
    }

    private boolean isPgHbaError(String normalizedMessage) {
        return normalizedMessage.contains("pg_hba.conf")
                || normalizedMessage.contains("no pg_hba")
                || normalizedMessage.contains("no pg hba");
    }

    /**
     * Kaynak PG'deki database listesini kesfeder ve merkezi DB'ye yazar.
     */
    private void discoverDatabases(Connection conn, SourceQueries queries,
                                   long instancePk) throws Exception {
        try (Statement stmt = conn.createStatement();
             ResultSet rs = stmt.executeQuery(queries.databaseListQuery())) {
            while (rs.next()) {
                long dbid = rs.getLong("dbid");
                String datname = rs.getString("datname");
                boolean isTemplate = rs.getBoolean("is_template");

                // dim.database_ref upsert
                dimensionRepo.upsertDatabaseRef(instancePk, dbid, datname, isTemplate);

                // control.database_state upsert (yeni DB icin satir olusur)
                stateRepo.upsertDatabaseState(instancePk, dbid);
            }
        }
    }
}
