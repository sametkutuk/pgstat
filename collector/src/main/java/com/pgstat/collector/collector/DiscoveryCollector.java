package com.pgstat.collector.collector;

import com.pgstat.collector.model.AlertCode;
import com.pgstat.collector.model.InstanceCapability;
import com.pgstat.collector.model.InstanceInfo;
import com.pgstat.collector.repository.CapabilityRepository;
import com.pgstat.collector.repository.DimensionRepository;
import com.pgstat.collector.repository.StateRepository;
import com.pgstat.collector.service.AlertService;
import com.pgstat.collector.service.PgStatStatementsExtensionResolver;
import com.pgstat.collector.service.PgStatStatementsExtensionResolver.PgStatStatementsExtension;
import com.pgstat.collector.service.SecretResolver;
import com.pgstat.collector.service.SqlFamilyResolver;
import com.pgstat.collector.service.SourceConnectionFactory;
import com.pgstat.collector.sql.SourceQueries;
import com.pgstat.collector.telemetry.PgssCapabilityCatalog;
import com.pgstat.collector.telemetry.PgssCapabilityCatalog.PgssVersion;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

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
    private final PgssCapabilityCatalog pgssCatalog;
    private final org.springframework.jdbc.core.JdbcTemplate jdbc;
    private final AlertService alertService;

    public DiscoveryCollector(SourceConnectionFactory connectionFactory,
                              SqlFamilyResolver familyResolver,
                              CapabilityRepository capabilityRepo,
                              StateRepository stateRepo,
                              DimensionRepository dimensionRepo,
                              PgStatStatementsExtensionResolver pgssResolver,
                              PgssCapabilityCatalog pgssCatalog,
                              org.springframework.jdbc.core.JdbcTemplate jdbc,
                              AlertService alertService) {
        this.connectionFactory = connectionFactory;
        this.familyResolver = familyResolver;
        this.capabilityRepo = capabilityRepo;
        this.stateRepo = stateRepo;
        this.dimensionRepo = dimensionRepo;
        this.pgssResolver = pgssResolver;
        this.pgssCatalog = pgssCatalog;
        this.jdbc = jdbc;
        this.alertService = alertService;
    }

    /**
     * Acik bir baglanti uzerinden server_version_num'i son kaydedilen degerle
     * karsilastirir. Farkli ise (orn. pg_upgrade ile major surum degisti),
     * capability'yi tam discover() ile yeniden kesfeder ve bir bilgi alert'i
     * uretir — boylece pg_major'a bagli davranislar (orn. PG16+ pg_stat_io
     * toplama) bir sonraki cycle'da dogru calisir. Her cluster toplama
     * dongusunde cagrilmasi icin tasarlandi; ek maliyeti tek bir sorgudur
     * (surum degismediyse discover() tetiklenmez).
     *
     * @param instance hedef instance
     * @param conn     zaten acik olan kaynak baglanti (yeniden baglanmaz)
     */
    public void recheckVersionIfChanged(InstanceInfo instance, Connection conn) {
        try {
            int liveServerVersionNum;
            try (Statement stmt = conn.createStatement();
                 ResultSet rs = stmt.executeQuery(
                     "select current_setting('server_version_num')::integer as server_version_num")) {
                rs.next();
                liveServerVersionNum = rs.getInt("server_version_num");
            }

            Integer recordedServerVersionNum = capabilityRepo.findServerVersionNum(instance.instancePk());
            OffsetDateTime pgssCheckedAt = capabilityRepo.findPgssCheckedAt(instance.instancePk());
            boolean versionChanged = recordedServerVersionNum == null
                    || recordedServerVersionNum != liveServerVersionNum;

            // KANITIN ANLAMI KATALOGA BAGLIDIR. Ayni kolon, katalog
            // degistiginde farkli bir kaynaktan ya da farkli bir semantikle
            // uretilmis olabilir; kayitli revizyon calisandan farkliysa o
            // instance'in yetenek kaniti baska bir katalogla yazilmistir.
            // Yazip hic okumamak, kaydi susleme haline getirirdi.
            Integer recordedCatalogVersion = capabilityRepo.findPgssCatalogVersion(instance.instancePk());
            boolean catalogChanged = recordedCatalogVersion == null
                    || recordedCatalogVersion != pgssCatalog.catalogVersion();

            if (!versionChanged && pgssCheckedAt != null && !catalogChanged) {
                return;
            }

            int oldPgMajor = recordedServerVersionNum != null
                    ? SqlFamilyResolver.extractPgMajor(recordedServerVersionNum) : -1;
            int newPgMajor = SqlFamilyResolver.extractPgMajor(liveServerVersionNum);
            if (versionChanged) {
                log.info("PG surum degisikligi tespit edildi: {} — PG{} -> PG{} ({} -> {}), yeniden kesfediliyor",
                        instance.instanceId(), oldPgMajor, newPgMajor, recordedServerVersionNum, liveServerVersionNum);
            } else if (pgssCheckedAt == null) {
                log.info("pgss kesif kaniti eksik: {} — PG{} degismedi, yeniden kesfediliyor",
                        instance.instanceId(), newPgMajor);
            } else {
                log.info("pgss katalog revizyonu degisti: {} — kayitli {} -> calisan {}, yeniden kesfediliyor",
                        instance.instanceId(), recordedCatalogVersion, pgssCatalog.catalogVersion());
            }

            discover(instance);

            if (!versionChanged) return;

            // Bu bir kalici sorun degil, tek seferlik bir bilgilendirme —
            // raise hemen ardindan resolve edilerek UI'da "acik alert" olarak
            // kalici gorunmesi engellenir (audit/bildirim amacli tetiklenir,
            // aktif alert listesinde asili kalmaz).
            alertService.raiseInstanceAlert(AlertCode.INSTANCE_PG_VERSION_CHANGED, instance.instancePk(),
                    "PostgreSQL sürümü değişti: " + instance.instanceId(),
                    String.format(
                        "%s instance'ının PostgreSQL sürümü PG%d'den PG%d'ye değişti (%d -> %d). " +
                        "Yetenek bilgileri (pg_major, sql_family, extension durumu) otomatik olarak " +
                        "yeniden keşfedildi; geçmiş toplanan veriler etkilenmedi.",
                        instance.instanceId(), oldPgMajor, newPgMajor,
                        recordedServerVersionNum, liveServerVersionNum));
            alertService.resolveInstanceAlert(AlertCode.INSTANCE_PG_VERSION_CHANGED, instance.instancePk());

        } catch (Exception e) {
            log.warn("Surum kontrolu hatasi (yoksayildi): {} — {}", instance.instanceId(), e.getMessage());
        }
    }

    /**
     * Instance kesfini calistirir.
     *
     * @param instance hedef instance bilgileri
     * @return kesfedilen yetenekler; hata durumunda null
     */
    /**
     * Hafif yeniden-kesif: SADECE database listesini yeniler (version/capability/pgss
     * gibi agir adimlari ATLAR). Bootstrap'tan sonra 'ready' instance'larda periyodik
     * cagrilir ki sonradan eklenen database'ler (dim.database_ref) yakalansin.
     * SQL family capability'den okunur (bootstrap'ta tespit edilmisti).
     *
     * @return kesfedilen (template olmayan) database sayisi; baglanti hatasinda -1
     */
    public int rediscoverDatabases(InstanceInfo instance) {
        String sqlFamily = capabilityRepo.findSqlFamily(instance.instancePk());
        if (sqlFamily == null) {
            log.debug("Rediscovery atlandi (sql_family yok, bootstrap tamamlanmamis): {}",
                    instance.instanceId());
            return -1;
        }
        SourceQueries queries = familyResolver.resolveByCode(sqlFamily);
        try (Connection conn = connectionFactory.connect(instance)) {
            int before = countKnownDatabases(instance.instancePk());
            discoverDatabases(conn, queries, instance.instancePk());
            int after = countKnownDatabases(instance.instancePk());
            if (after > before) {
                log.info("Rediscovery: {} — {} yeni database kesfedildi (toplam {})",
                        instance.instanceId(), after - before, after);
            }
            return after;
        } catch (Exception e) {
            log.warn("Rediscovery hatasi: {} — {}", instance.instanceId(), e.getMessage());
            return -1;
        }
    }

    private int countKnownDatabases(long instancePk) {
        try {
            Integer n = jdbc.queryForObject(
                "select count(*) from dim.database_ref where instance_pk = ?",
                Integer.class, instancePk);
            return n != null ? n : 0;
        } catch (Exception e) {
            return 0;
        }
    }

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

            // Adim 2: Admin DB once denenir. Orada kullanilabilir degilse
            // baglantiya acik diger DB'ler deterministik sirayla taranir.
            // Extension nesneleri DB-yereldir; pgss verisi ise kume genelidir.
            // Bu nedenle ilk kullanilabilir DB secilir ve yalnizca oradan toplanir.
            PgssDiscovery pgssDiscovery = discoverPgssAcrossDatabases(
                    instance, conn, queries, instance.adminDbname());
            PgStatStatementsExtension pgssExtension = pgssDiscovery.extension();
            String pgssCollectionDbname = pgssDiscovery.databaseName();
            boolean pgssPermissionDenied = pgssDiscovery.permissionDenied();
            boolean pgssCollectionFailed = pgssDiscovery.collectionFailed();
            hasPgss = pgssExtension != null;

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
            PgssCapabilityCatalog.PgssVersion discoveredPgssVersion = pgssExtension != null
                    ? PgssCapabilityCatalog.PgssVersion.of(pgssExtension.extVersion())
                    : null;
            if (pgssCatalog.supportsInfoView(discoveredPgssVersion)
                    && hasPgss && !pgssPermissionDenied && !pgssCollectionFailed) {
                Connection pgssConn = conn;
                boolean closePgssConn = !instance.adminDbname().equals(pgssCollectionDbname);
                try {
                    if (closePgssConn) pgssConn = connectionFactory.connect(instance, pgssCollectionDbname);
                    try (Statement stmt = pgssConn.createStatement();
                         ResultSet rs = stmt.executeQuery(queries.pgssInfoQuery(pgssInfoRelation))) {
                        if (rs.next()) {
                            pgssStatsResetAt = rs.getObject("last_stats_reset", OffsetDateTime.class);
                            hasPgssInfo = true;
                        }
                    }
                } catch (Exception e) {
                    log.warn("pg_stat_statements_info okunamadi: instance={}, schema={}, hata={}",
                            instance.instanceId(),
                            pgssExtension != null ? pgssExtension.schemaName() : null,
                            e.getMessage());
                } finally {
                    if (closePgssConn && pgssConn != conn) {
                        try { pgssConn.close(); } catch (SQLException ignored) { }
                    }
                }
            }

            // 6. Capability olustur ve secilen toplama DB'sini kanita kaydet.
            String pgssStatus = pgssStatus(pgssExtension, pgssPermissionDenied, pgssCollectionFailed);
            OffsetDateTime pgssVerifiedAt = OffsetDateTime.now();
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
                pgssStatus,
                pgssExtension != null ? pgssExtension.extVersion() : null,
                pgssCollectionDbname,
                pgssInPreload,
                pgssCatalog.catalogVersion(),
                pgssVerifiedAt,
                computeQueryIdMode,
                sqlFamily,
                postmasterStartAt,
                pgssStatsResetAt,
                OffsetDateTime.now(), // lastDiscoveredAt
                null, // lastErrorAt
                null  // Basarili discovery eski serbest metin hatasini temizler.
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

    PgssDiscovery discoverPgssAcrossDatabases(InstanceInfo instance, Connection adminConnection,
                                               SourceQueries queries, String adminDbname)
            throws SQLException {
        PgssDiscovery evidence = inspectPgss(instance, adminConnection, adminDbname);
        if (evidence.available()) return evidence;

        // EN YUKSEK SURUM KAZANIR, ALFABETIK ILK DEGIL.
        //
        // pgss extension surumu VERITABANI BASINADIR: ayni sunucuda appdb'de
        // 1.9, zebra'da 1.11 olabilir (biri guncellenmis, digeri degil). Veri
        // kume geneli oldugu icin hangisinden okudugumuz VERIYI degistirmez,
        // ama HANGI KOLONLARI gorebildigimizi degistirir — 1.9'dan okursak
        // toplevel, jit_* ve stats_since kolonlarini, ayni sunucuda mevcut
        // olmalarina ragmen kaybederiz.
        //
        // Bedeli: ilk bulunanda durmak yerine adaylar taranmaya devam eder.
        // Katalogun bildigi en yuksek surum bulunursa erken cikilir, cunku
        // daha iyisi zaten okunamaz. Bu yol nadir — admin DB'de bulunamazsa
        // calisir — ve dogruluk, oradaki birkac baglantidan onemli.
        PgssDiscovery best = null;
        PgssVersion ceiling = pgssCatalog.highestKnownVersion();

        for (String dbname : listDatabaseNames(adminConnection, queries)) {
            if (adminDbname.equals(dbname)) continue;
            try (Connection candidate = connectionFactory.connect(instance, dbname)) {
                PgssDiscovery found = inspectPgss(instance, candidate, dbname);
                if (!found.available()) {
                    evidence = evidence.merge(found);
                    continue;
                }
                if (best == null || isHigherVersion(found, best)) {
                    best = found;
                }
                PgssVersion bestVersion = versionOf(best);
                if (bestVersion != null && ceiling != null && bestVersion.compareTo(ceiling) >= 0) {
                    break;
                }
            } catch (SQLException e) {
                // Bir DB'ye CONNECT izni olmamasi, instance veya pgss'in tamamini
                // erisilemez yapmaz. Diger adaylar taranmaya devam edilir.
                log.debug("pgss DB adayi atlandi: instance={}, database={}, sqlstate={}, hata={}",
                        instance.instanceId(), dbname, e.getSQLState(), e.getMessage());
            }
        }

        if (best != null) {
            log.info("pg_stat_statements admin DB disinda bulundu: instance={}, database={}, surum={}",
                    instance.instanceId(), best.databaseName(), versionOf(best));
            return best;
        }
        return evidence;
    }

    private static PgssVersion versionOf(PgssDiscovery discovery) {
        return discovery.extension() == null ? null : PgssVersion.of(discovery.extension().extVersion());
    }

    /**
     * Aday, mevcut en iyiden daha yuksek surumlu mu?
     *
     * Ayristirilamayan surum EN DUSUK sayilir: okunabilir ama surumu bilinmeyen
     * bir kurulum, surumu bilinen birine tercih edilmemeli — bilinmeyen surum
     * savunmaci projection'a duser ve kolonlarin bir kismi varsayilan olur.
     * Esitlikte ilk gelen kalir; liste ada gore sirali oldugu icin secim kararli.
     */
    private static boolean isHigherVersion(PgssDiscovery candidate, PgssDiscovery current) {
        PgssVersion a = versionOf(candidate);
        PgssVersion b = versionOf(current);
        if (a == null) return false;
        if (b == null) return true;
        return a.compareTo(b) > 0;
    }

    private List<String> listDatabaseNames(Connection conn, SourceQueries queries) throws SQLException {
        List<String> names = new ArrayList<>();
        try (Statement stmt = conn.createStatement();
             ResultSet rs = stmt.executeQuery(queries.databaseListQuery())) {
            while (rs.next()) names.add(rs.getString("datname"));
        }
        return names;
    }

    private PgssDiscovery inspectPgss(InstanceInfo instance, Connection conn, String dbname)
            throws SQLException {
        PgStatStatementsExtension extension;
        try {
            extension = pgssResolver.resolve(conn);
        } catch (SQLException e) {
            if ("42501".equals(e.getSQLState())) {
                log.warn("pg_stat_statements kesfi icin yetki yok: instance={}, database={}",
                        instance.instanceId(), dbname);
                return new PgssDiscovery(null, dbname, true, false);
            }
            if (e.getSQLState() != null && e.getSQLState().startsWith("08")) throw e;
            log.warn("pg_stat_statements metadata kesfi basarisiz: instance={}, database={}, sqlstate={}, hata={}",
                    instance.instanceId(), dbname, e.getSQLState(), e.getMessage());
            return new PgssDiscovery(null, dbname, false, true);
        }
        if (extension == null) return new PgssDiscovery(null, dbname, false, false);

        // Metadata gorunurlugu, collector'in gercekte cagirdigi SRF icin EXECUTE
        // yetkisini kanitlamaz. LIMIT 0 executor init'te yetkiyi denetler, fakat
        // fonksiyonu calistirip satir tasimaz.
        try (Statement stmt = conn.createStatement()) {
            stmt.executeQuery("select 1 from "
                    + extension.qualify("pg_stat_statements") + "(false) limit 0").close();
            return new PgssDiscovery(extension, dbname, false, false);
        } catch (SQLException e) {
            if ("42501".equals(e.getSQLState())) {
                log.warn("pg_stat_statements nesnesi okunamiyor: instance={}, database={}, schema={}",
                        instance.instanceId(), dbname, extension.schemaName());
                return new PgssDiscovery(extension, dbname, true, false);
            }
            if (e.getSQLState() != null && e.getSQLState().startsWith("08")) throw e;
            log.warn("pg_stat_statements probe basarisiz: instance={}, database={}, sqlstate={}, hata={}",
                    instance.instanceId(), dbname, e.getSQLState(), e.getMessage());
            return new PgssDiscovery(extension, dbname, false, true);
        }
    }

    record PgssDiscovery(PgStatStatementsExtension extension, String databaseName,
                         boolean permissionDenied, boolean collectionFailed) {
        boolean available() {
            return extension != null && !permissionDenied && !collectionFailed;
        }

        PgssDiscovery merge(PgssDiscovery other) {
            PgStatStatementsExtension chosenExtension = extension != null ? extension : other.extension;
            String chosenDatabase = extension != null ? databaseName
                    : other.extension != null ? other.databaseName : databaseName;
            return new PgssDiscovery(chosenExtension, chosenDatabase,
                    permissionDenied || other.permissionDenied,
                    collectionFailed || other.collectionFailed);
        }
    }

    /** Veritabani kapsami taramasinin kanita yazilan deterministik pgss durumu. */
    static String pgssStatus(PgStatStatementsExtension extension, boolean permissionDenied,
                             boolean collectionFailed) {
        if (permissionDenied) return "permission_denied";
        if (collectionFailed) return "collection_failed";
        if (extension == null) return "not_installed";
        return PgssCapabilityCatalog.PgssVersion.of(extension.extVersion()) == null
                ? "version_unknown"
                : "available";
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
     * Ayrica, kaynakta artik gorulmeyen (drop edilmis) ama dim.database_ref'te
     * hala is_active=true olan database'leri otomatik olarak takipten cikarir
     * (bkz. discoverDatabases sonrasi deactivateMissingDatabases cagrisi) —
     * aksi halde collector o database'e sonsuza kadar baglanmaya calisip
     * her denemede system_stat_collection_failed alert'i acardi (musteri
     * raporu, 2026-08-12).
     */
    private void discoverDatabases(Connection conn, SourceQueries queries,
                                   long instancePk) throws Exception {
        List<Long> seenDbids = new ArrayList<>();
        try (Statement stmt = conn.createStatement();
             ResultSet rs = stmt.executeQuery(queries.databaseListQuery())) {
            while (rs.next()) {
                long dbid = rs.getLong("dbid");
                String datname = rs.getString("datname");
                boolean isTemplate = rs.getBoolean("is_template");
                seenDbids.add(dbid);

                // dim.database_ref upsert
                dimensionRepo.upsertDatabaseRef(instancePk, dbid, datname, isTemplate);

                // control.database_state upsert (yeni DB icin satir olusur)
                stateRepo.upsertDatabaseState(instancePk, dbid);
            }
        }
        deactivateMissingDatabases(instancePk, seenDbids);
    }

    /**
     * dim.database_ref'te is_active=true olup, kaynak PG'nin guncel database
     * listesinde (seenDbids) artik gorulmeyen satirlari otomatik pasife ceker.
     * Manuel "Database Cleanup" (databaseCleanup.ts /disable) ile ayni deseni
     * (is_active, disabled_at, disabled_reason, database_action_log) kullanir,
     * boylece iki yol da ayni audit izini birakir.
     */
    private void deactivateMissingDatabases(long instancePk, List<Long> seenDbids) {
        List<Map<String, Object>> stale = jdbc.queryForList("""
            select dbid, datname
            from dim.database_ref
            where instance_pk = ? and is_active
              and not (dbid = any(?))
            """,
            instancePk, seenDbids.toArray(new Long[0])
        );
        if (stale.isEmpty()) return;

        for (Map<String, Object> row : stale) {
            long dbid = ((Number) row.get("dbid")).longValue();
            String datname = String.valueOf(row.get("datname"));
            try {
                jdbc.update("""
                    update dim.database_ref
                    set is_active = false, disabled_at = now(),
                        disabled_reason = 'auto: source database no longer exists'
                    where instance_pk = ? and dbid = ?
                    """, instancePk, dbid);
                jdbc.update("""
                    insert into control.database_action_log
                        (instance_pk, dbid, datname, action, reason, actioned_by)
                    values (?, ?, ?, 'disabled', 'auto: source database no longer exists', 'collector')
                    """, instancePk, dbid, datname);
                log.info("Database takipten otomatik cikarildi (kaynakta bulunamadi): instance_pk={} dbid={} datname={}",
                    instancePk, dbid, datname);
            } catch (Exception e) {
                log.warn("Database otomatik disable hatasi: instance_pk={} dbid={} — {}",
                    instancePk, dbid, e.getMessage());
            }
        }

        try {
            alertService.resolveSystemAlert("system.stat_collection_failed:instance=" + instancePk);
        } catch (Exception ignore) {}
    }
}
