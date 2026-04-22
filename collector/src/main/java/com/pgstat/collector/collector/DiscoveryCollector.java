package com.pgstat.collector.collector;

import com.pgstat.collector.model.InstanceCapability;
import com.pgstat.collector.model.InstanceInfo;
import com.pgstat.collector.repository.CapabilityRepository;
import com.pgstat.collector.repository.DimensionRepository;
import com.pgstat.collector.repository.StateRepository;
import com.pgstat.collector.service.SecretResolver;
import com.pgstat.collector.service.SqlFamilyResolver;
import com.pgstat.collector.service.SourceConnectionFactory;
import com.pgstat.collector.sql.SourceQueries;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.OffsetDateTime;

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

    public DiscoveryCollector(SourceConnectionFactory connectionFactory,
                              SqlFamilyResolver familyResolver,
                              CapabilityRepository capabilityRepo,
                              StateRepository stateRepo,
                              DimensionRepository dimensionRepo) {
        this.connectionFactory = connectionFactory;
        this.familyResolver = familyResolver;
        this.capabilityRepo = capabilityRepo;
        this.stateRepo = stateRepo;
        this.dimensionRepo = dimensionRepo;
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
            boolean hasPgss = false;
            boolean hasPgssInfo = false;
            boolean hasPgStatIo = false;
            boolean hasPgStatCheckpointer = false;

            try (Statement stmt = conn.createStatement();
                 ResultSet rs = stmt.executeQuery(queries.extensionCheckQuery())) {
                while (rs.next()) {
                    if ("pg_stat_statements".equals(rs.getString("extname"))) {
                        hasPgss = true;
                    }
                }
            }

            // PG14+ icin pg_stat_statements_info kontrolu
            hasPgssInfo = queries.pgssInfoQuery() != null && hasPgss;

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
            if (queries.pgssInfoQuery() != null && hasPgss) {
                try (Statement stmt = conn.createStatement();
                     ResultSet rs = stmt.executeQuery(queries.pgssInfoQuery())) {
                    if (rs.next()) {
                        pgssStatsResetAt = rs.getObject("last_stats_reset", OffsetDateTime.class);
                    }
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
            return null;

        } catch (Exception e) {
            log.error("Discovery hatasi: {} — {}", instance.instanceId(), e.getMessage(), e);
            capabilityRepo.markUnreachable(instance.instancePk(), e.getMessage());
            return null;
        }
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
