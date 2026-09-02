package com.pgstat.collector.collector;

import com.pgstat.collector.model.DbObjectsTarget;
import com.pgstat.collector.model.InstanceInfo;
import com.pgstat.collector.repository.CapabilityRepository;
import com.pgstat.collector.repository.DimensionRepository;
import com.pgstat.collector.repository.FactRepository;
import com.pgstat.collector.service.DeltaCalculator;
import com.pgstat.collector.service.SqlFamilyResolver;
import com.pgstat.collector.service.SourceConnectionFactory;
import com.pgstat.collector.sql.SourceQueries;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.OffsetDateTime;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * DbObjects job — per-database tablo ve index istatistikleri toplama.
 *
 * Adimlar:
 * 1. Hedef database'e baglan (admin_dbname degil, datname'e baglanir)
 * 2. pg_stat_user_tables + pg_statio_user_tables → delta → fact.pg_table_stat_delta
 * 3. pg_stat_user_indexes + pg_statio_user_indexes → delta → fact.pg_index_stat_delta
 * 4. pg_stat_database → delta → fact.pg_database_delta
 * 5. dim.relation_ref upsert (yeni tablo/index kesfedilmisse)
 *
 * Delta cache: "instancePk:dbid" → (relid → kumulatif degerler Map)
 */
@Component
public class DbObjectsCollector {

    private static final Logger log = LoggerFactory.getLogger(DbObjectsCollector.class);

    private final SourceConnectionFactory connectionFactory;
    private final SqlFamilyResolver familyResolver;
    private final CapabilityRepository capabilityRepo;
    private final DimensionRepository dimensionRepo;
    private final FactRepository factRepo;
    private final DeltaCalculator deltaCalc;

    /** Table stats delta cache: "instancePk:dbid:relid" → metrik map */
    private final ConcurrentHashMap<String, Map<String, Long>> previousTableStats = new ConcurrentHashMap<>();

    /** Index stats delta cache: "instancePk:dbid:indexRelid" → metrik map */
    private final ConcurrentHashMap<String, Map<String, Long>> previousIndexStats = new ConcurrentHashMap<>();

    /** Database stats delta cache: "instancePk:dbid" → metrik map */
    private final ConcurrentHashMap<String, Map<String, Double>> previousDbStats = new ConcurrentHashMap<>();

    /** Table vacuum_time delta cache: "instancePk:dbid:relid:vt" → [vacuum, autovacuum, analyze, autoanalyze] */
    private final ConcurrentHashMap<String, double[]> previousTableVacuumTime = new ConcurrentHashMap<>();

    public DbObjectsCollector(SourceConnectionFactory connectionFactory,
                              SqlFamilyResolver familyResolver,
                              CapabilityRepository capabilityRepo,
                              DimensionRepository dimensionRepo,
                              FactRepository factRepo,
                              DeltaCalculator deltaCalc) {
        this.connectionFactory = connectionFactory;
        this.familyResolver = familyResolver;
        this.capabilityRepo = capabilityRepo;
        this.dimensionRepo = dimensionRepo;
        this.factRepo = factRepo;
        this.deltaCalc = deltaCalc;
    }

    /**
     * Per-database istatistik toplama.
     * Instance'a datname uzerinden baglanir (admin_dbname degil).
     *
     * @param target due database bilgileri
     * @return yazilan satir sayisi
     */
    public long collect(DbObjectsTarget target) throws Exception {
        long instancePk = target.instancePk();
        String sqlFamily = capabilityRepo.findSqlFamily(instancePk);
        SourceQueries queries = familyResolver.resolveByCode(sqlFamily);
        OffsetDateTime now = OffsetDateTime.now();
        long rowsWritten = 0;

        // Hedef database'e baglanmak icin InstanceInfo olustur
        InstanceInfo instanceForDb = new InstanceInfo(
            target.instancePk(), target.instanceId(),
            target.host(), target.port(), target.datname(),
            target.secretRef(), target.sslMode(), "ready",
            target.collectorUsername(),
            target.connectTimeoutSeconds(), target.statementTimeoutMs(),
            target.lockTimeoutMs(), 0, 60, 300, 21600, null, null
        );

        try (Connection conn = connectionFactory.connect(instanceForDb)) {

            // Database-level stats (pg_stat_database icin admin_dbname'den baglanabilir ama
            // burada zaten datname'e baglandik — tum veritabanlari icin metrikler doner)
            rowsWritten += collectDatabaseStats(conn, queries, instancePk, target.dbid(),
                    target.datname(), now);

            // Table stats
            rowsWritten += collectTableStats(conn, queries, instancePk, target.dbid(), now);

            // Index stats
            rowsWritten += collectIndexStats(conn, queries, instancePk, target.dbid(), now);

            // Izleme listesindeki tablolarin boyutu (PGSTAT-P0-045)
            rowsWritten += collectWatchedTableSizes(conn, instancePk, target.dbid(), now);
        }

        log.debug("DbObjects toplama tamamlandi: {}:{} — {} satir",
                target.instanceId(), target.datname(), rowsWritten);

        return rowsWritten;
    }

    /**
     * Izleme listesindeki tablolarin boyutunu her toplama dongusunde olcer
     * (PGSTAT-P0-045).
     *
     * Boyut normalde yalnizca gece toplanir; fiziksel sisme alarmi bu yuzden 24
     * saate kadar eski bir olcume dayanabiliyordu. Butun tablolari sik olcmek
     * pahali — gecede ~6.900 relation topluyoruz ve saatlige cikarmak
     * fact.pg_relation_size_snapshot'i ~80 MB'dan ~2 GB'a tasirdi.
     *
     * Musteri onerisi (2026-08-31): alarm almis tablolari daha sik izlemek daha
     * mantikli. Bir tabloya gun icinde yogun UPDATE/INSERT/DELETE gelmis
     * olabilir ve durumu gece olcumunden tamamen farklidir.
     *
     * Liste bilincli olarak dar: acik bir bloat alarmi olan tablolar. Bunlar
     * zaten operatorun ilgilendigi, muhtemelen mudahale edecegi tablolar; hem
     * "duzelttim ama alarm kapanmiyor" gecikmesini ortadan kaldirir hem de
     * maliyeti bir avuc relation ile sinirli kalir.
     */
    private long collectWatchedTableSizes(Connection conn, long instancePk, long dbid,
                                          OffsetDateTime now) {
        java.util.List<String[]> watched =
            factRepo.findWatchedTables(instancePk, dbid, WATCHED_TABLE_LIMIT);
        if (watched.isEmpty()) return 0;

        long rows = 0;
        for (String[] t : watched) {
            try (PreparedStatement ps = conn.prepareStatement(
                    // to_regclass: tablo silinmis/adi degismisse NULL doner ve
                    // hata firlatmaz. Boyut fonksiyonlari NULL'da NULL verir,
                    // asagida atlaniyor.
                    "select pg_total_relation_size(c.oid) as total_size_bytes," +
                    "       pg_relation_size(c.oid) as table_size_bytes," +
                    "       coalesce((select sum(pg_relation_size(i.indexrelid))" +
                    "                   from pg_index i where i.indrelid = c.oid), 0)::bigint as index_size_bytes," +
                    "       case when c.reltoastrelid > 0" +
                    "            then pg_total_relation_size(c.reltoastrelid) end as toast_size_bytes," +
                    "       nullif(c.reltuples, -1)::bigint as reltuples," +
                    "       c.oid::bigint as relid," +
                    "       coalesce(nullif(substring(array_to_string(c.reloptions, ',')" +
                    "                 from 'fillfactor=([0-9]+)'), '')::int, 100) as fillfactor," +
                    // Ankraj: reltuples bu anda degil, son vacuum/analyze aninda
                    // guncellenmistir (V109, PGSTAT-P0-046).
                    "       greatest(st.last_vacuum, st.last_autovacuum," +
                    "                st.last_analyze, st.last_autoanalyze) as reltuples_anchor_at," +
                    "       c.relkind::text as relkind" +
                    "  from pg_class c" +
                    "  left join pg_stat_all_tables st on st.relid = c.oid" +
                    " where c.oid = to_regclass(quote_ident(?) || '.' || quote_ident(?))" +
                    "   and c.relkind in ('r','m')")) {
                ps.setString(1, t[0]);
                ps.setString(2, t[1]);
                try (ResultSet rs = ps.executeQuery()) {
                    if (!rs.next()) continue;
                    // NOT: (Long) rs.getObject(...) kullanilmiyor. JDBC sutunun
                    // SQL tipine gore Long DEGIL BigDecimal dondurebiliyor ve o
                    // durumda cast ClassCastException atiyordu; hata asagidaki
                    // catch'te yutuldugu icin izleme yolu haftalarca sessizce
                    // hicbir satir yazmadi. getLong/getInt donusumu kendisi
                    // yapar. Gece toplayicisi da ayni deseni kullaniyor
                    // (NightlySnapshotCollector).
                    factRepo.insertRelationSizeSnapshot(now, instancePk, dbid, t[0], t[1],
                        rs.getString("relkind"),
                        rs.getObject("total_size_bytes")  != null ? rs.getLong("total_size_bytes")  : null,
                        rs.getObject("table_size_bytes")  != null ? rs.getLong("table_size_bytes")  : null,
                        rs.getObject("index_size_bytes")  != null ? rs.getLong("index_size_bytes")  : null,
                        rs.getObject("toast_size_bytes")  != null ? rs.getLong("toast_size_bytes")  : null,
                        rs.getObject("reltuples")         != null ? rs.getLong("reltuples")         : null,
                        rs.getObject("relid")             != null ? rs.getLong("relid")            : null,
                        rs.getObject("fillfactor")        != null ? rs.getInt("fillfactor")        : null,
                        rs.getObject("reltuples_anchor_at", OffsetDateTime.class),
                        // Bu gozlem taban havuzuna GIRMEZ: tablo zaten alarmli
                        // oldugu icin toplaniyor, yani sismis ani orneklemeye
                        // meyilli (V110).
                        "watched");
                    rows++;
                }
            } catch (Exception e) {
                // WARN, DEBUG degil. Bu blok bir ClassCastException'i haftalarca
                // sakladi: toplama her dongude calisiyor gorunuyordu ama tek satir
                // yazmiyordu ve log tamamen sessizdi. Tek bir tablonun okunamamasi
                // dongueyu durdurmamali, ama gorunmez de olmamali.
                log.warn("Izlenen tablo boyutu okunamadi instance={} dbid={} tablo={}.{}",
                    instancePk, dbid, t[0], t[1], e);
            }
        }
        if (rows > 0) {
            log.debug("Izlenen tablo boyutu olculdu: instance={} dbid={} {} tablo",
                instancePk, dbid, rows);
        }
        return rows;
    }

    /**
     * Fiziksel nesil degisimini yakalar ve siniflandirir (PGSTAT-P0-046 Faz 2).
     *
     * NEDEN VAR
     * ---------
     * Fiziksel sisme kuralinin tabani su an "28 gunde gordugum en dusuk deger",
     * yani tabloyu sikisikken yakalamis olmayi UMUT ediyoruz. Gozlem
     * penceresinde hic sikisik olmamis bir tablo icin taban da siskin cikar ve
     * gercek sisme kacirilir.
     *
     * VACUUM FULL / CLUSTER tabloyu yeni bir dosyaya yazar, relfilenode degisir
     * (kontrollu deney 2026-09-01). O andaki olcum TANIMI GEREGI sikisik
     * haldir — taban umut degil kanit olur.
     *
     * AMA HER NESIL DEGISIMI SIKISTIRMA DEGIL
     * ----------------------------------------
     * ALTER TABLE ... SET TABLESPACE de filenode degistirir, ama fork'lari blok
     * blok kopyalar ve sismeyi AYNEN KORUR. Bu yuzden tablespace ile birlikte
     * bakilir ve olay siniflandirilmadan taban sayilmaz.
     *
     * TABAN NEDEN relpages
     * --------------------
     * Rewrite sonunda relpages ve reltuples BIRLIKTE yazilir — tutarli bir
     * cift. Bizim sonradan okudugumuz pg_relation_size ise o arada buyumus
     * olabilir ve event-time reltuples ile karisir.
     */
    private void detectPhysicalGeneration(long instancePk, long dbid, long relid,
                                          String schemaname, String relname,
                                          ResultSet rs, OffsetDateTime now,
                                          java.util.Map<Long, FactRepository.PhysicalState> prevPhysical,
                                          java.util.Map<Long, long[]> unconfirmed) {
        try {
            Long relfilenode   = rs.getObject("relfilenode")   != null ? rs.getLong("relfilenode")   : null;
            Long reltablespace = rs.getObject("reltablespace") != null ? rs.getLong("reltablespace") : null;
            Long relpages      = rs.getObject("relpages")      != null ? rs.getLong("relpages")      : null;
            Long relt          = rs.getObject("reltuples")     != null ? rs.getLong("reltuples")     : null;
            Integer blockSize  = rs.getObject("block_size")    != null ? rs.getInt("block_size")     : null;

            FactRepository.PhysicalState prev = prevPhysical.get(relid);

            // Ilk gorus: kaydet, olay uretme. Neyle karsilastiracagimiz yok.
            if (prev == null) {
                factRepo.upsertPhysicalState(instancePk, dbid, relid, schemaname, relname,
                    relfilenode, reltablespace, relpages, relt, now);
                return;
            }

            boolean generationChanged =
                   !java.util.Objects.equals(prev.relfilenode(), relfilenode)
                || !java.util.Objects.equals(orZero(prev.reltablespace()), orZero(reltablespace));

            if (!generationChanged) {
                // N=2 DOGRULAMASI. Bekleyen bir olay varsa ve nesil ile
                // (relpages, reltuples) cifti ayni kaldiysa, olcum kendi icinde
                // tutarlidir. Ortalama almak icin degil — tutarliligi
                // dogrulamak icin.
                long[] pending = unconfirmed.get(relid);
                if (pending != null
                        && relfilenode != null && pending[1] == relfilenode
                        && relpages != null    && pending[2] == relpages
                        && relt != null        && pending[3] == relt) {
                    factRepo.confirmRewriteEvent(pending[0], now);
                    unconfirmed.remove(relid);
                }
                // Nesil ayniysa YAZMA YOK. Her donguede yazmak, PGSTAT-P0-047'de
                // duzeltilen yazma cogaltmasinin aynisini uretirdi.
                return;
            }

            String classification = classifyGenerationChange(
                prev.reltablespace(), reltablespace, relt, relpages, blockSize);
            java.math.BigDecimal baselineBpr =
                "compacting_rewrite_candidate".equals(classification)
                    ? compactBytesPerRow(relpages, blockSize, relt)
                    : null;

            // Gercek rewrite ani BILINMIYOR: [prev.observedAt, now] arasinda bir
            // yerde. Tek bir kesin zaman UYDURULMAZ; aralik saklanir.
            factRepo.insertRewriteEvent(instancePk, dbid, relid, schemaname, relname,
                prev.observedAt(), now,
                prev.relfilenode(), relfilenode,
                prev.reltablespace(), reltablespace,
                relpages, relt, blockSize, baselineBpr, classification);

            factRepo.upsertPhysicalState(instancePk, dbid, relid, schemaname, relname,
                relfilenode, reltablespace, relpages, relt, now);

            log.info("Fiziksel nesil degisti: {}.{} instance={} dbid={} {} (filenode {} -> {})",
                schemaname, relname, instancePk, dbid, classification,
                prev.relfilenode(), relfilenode);

        } catch (Exception e) {
            // WARN, DEBUG degil. Sessiz bir catch bu hafta iki kez haftalarca
            // suren hatayi sakladi.
            log.warn("Fiziksel nesil kontrolu basarisiz {}.{} instance={} dbid={}",
                schemaname, relname, instancePk, dbid, e);
        }
    }

    /** reltablespace 0 = veritabani varsayilani; NULL ile 0 ayni sey sayilir. */
    private static long orZero(Long v) { return v != null ? v : 0L; }

    /**
     * Fiziksel nesil degisimini siniflandirir.
     *
     * Sira onemli: TABLESPACE once bakilir. SET TABLESPACE fork'lari blok blok
     * kopyalar ve sismeyi AYNEN KORUR — filenode degismis olsa da bu bir
     * sikistirma degildir ve taban sayilamaz. Dis inceleme (2026-09-01) tam
     * olarak bu karsi ornegi gosterdi.
     */
    static String classifyGenerationChange(Long prevTablespace, Long newTablespace,
                                           Long reltuples, Long relpages, Integer blockSize) {
        if (orZero(prevTablespace) != orZero(newTablespace)) return "storage_move";
        // reltuples NULL = BILINMIYOR (kaynakta PG14+ -1 sentineli nullif ile
        // elenir), sifir DEGIL. Bunu "truncate" saymak, hic analiz gormemis
        // tablolari bos ilan etmek olurdu — canli veride tam bu oldu
        // (2026-09-02): -1 tasiyan onlarca tablo truncate isaretlendi.
        if (reltuples == null)                               return "unknown";
        if (reltuples == 0)                                  return "truncate";
        if (relpages == null || relpages <= 0)               return "unknown";
        if (blockSize == null || blockSize <= 0)             return "unknown";
        return "compacting_rewrite_candidate";
    }

    /**
     * Sikisik yogunluk: relpages * block_size / reltuples.
     *
     * relpages ve reltuples rewrite sonunda BIRLIKTE yazilir, yani tutarli bir
     * cift. pg_relation_size kullanilsaydi, tespit ile rewrite arasinda gecen
     * surede buyumus bir boyut, event-time satir sayisiyla bolunurdu.
     */
    static java.math.BigDecimal compactBytesPerRow(Long relpages, Integer blockSize, Long reltuples) {
        if (relpages == null || blockSize == null || reltuples == null || reltuples <= 0) return null;
        return java.math.BigDecimal.valueOf(relpages)
            .multiply(java.math.BigDecimal.valueOf(blockSize))
            .divide(java.math.BigDecimal.valueOf(reltuples), 6, java.math.RoundingMode.HALF_UP);
    }

    /**
     * Izleme listesi ust siniri. Dar tutuluyor: amac alarm almis tablolari
     * takip etmek, gece toplamasini taklit etmek degil. Sinir asilirsa geri
     * kalanlar gece olcumune kalir.
     */
    private static final int WATCHED_TABLE_LIMIT = 25;

    // -------------------------------------------------------------------------
    // Database stats
    // -------------------------------------------------------------------------

    private long collectDatabaseStats(Connection conn, SourceQueries queries,
                                      long instancePk, long dbid, String datname,
                                      OffsetDateTime now) throws Exception {
        String cacheKey = instancePk + ":" + dbid;
        Map<String, Double> current = new HashMap<>();
        // Snapshot kolonlari (delta degil): tek geciste oku — onceden iki ayri
        // executeQuery vardi, source PG'ye gereksiz extra round-trip getiriyordu.
        OffsetDateTime statsReset = null;
        OffsetDateTime checksumLastFailure = null;

        try (Statement stmt = conn.createStatement();
             ResultSet rs = stmt.executeQuery(queries.databaseStatsQuery())) {
            while (rs.next()) {
                if (rs.getLong("dbid") != dbid) continue; // Sadece hedef DB

                current.put("numbackends", (double) rs.getInt("numbackends"));
                current.put("xact_commit", rs.getDouble("xact_commit"));
                current.put("xact_rollback", rs.getDouble("xact_rollback"));
                current.put("blks_read", rs.getDouble("blks_read"));
                current.put("blks_hit", rs.getDouble("blks_hit"));
                current.put("tup_returned", rs.getDouble("tup_returned"));
                current.put("tup_fetched", rs.getDouble("tup_fetched"));
                current.put("tup_inserted", rs.getDouble("tup_inserted"));
                current.put("tup_updated", rs.getDouble("tup_updated"));
                current.put("tup_deleted", rs.getDouble("tup_deleted"));
                current.put("conflicts", rs.getDouble("conflicts"));
                current.put("temp_files", rs.getDouble("temp_files"));
                current.put("temp_bytes", rs.getDouble("temp_bytes"));
                current.put("deadlocks", rs.getDouble("deadlocks"));
                current.put("checksum_failures", rs.getDouble("checksum_failures"));
                current.put("blk_read_time", rs.getDouble("blk_read_time"));
                current.put("blk_write_time", rs.getDouble("blk_write_time"));
                current.put("session_time", rs.getDouble("session_time"));
                current.put("active_time", rs.getDouble("active_time"));
                current.put("idle_in_transaction_time", rs.getDouble("idle_in_transaction_time"));
                // V066: yeni kumulatif kolonlar
                current.put("sessions", rs.getDouble("sessions"));
                current.put("sessions_abandoned", rs.getDouble("sessions_abandoned"));
                current.put("sessions_fatal", rs.getDouble("sessions_fatal"));
                current.put("sessions_killed", rs.getDouble("sessions_killed"));
                current.put("parallel_workers_to_launch", rs.getDouble("parallel_workers_to_launch"));
                current.put("parallel_workers_launched", rs.getDouble("parallel_workers_launched"));
                // V066 snapshot kolonlari ayni ResultSet'ten okunuyor
                statsReset = rs.getObject("stats_reset", OffsetDateTime.class);
                checksumLastFailure = rs.getObject("checksum_last_failure", OffsetDateTime.class);
                break;
            }
        }

        Map<String, Double> prev = previousDbStats.put(cacheKey, current);
        if (prev == null || current.isEmpty()) return 0;

        int numbackends = current.get("numbackends").intValue();

        factRepo.insertDatabaseDelta(now, instancePk, dbid, datname, numbackends,
            d2l(deltaCalc.deltaDouble(current.get("xact_commit"), prev.get("xact_commit"))),
            d2l(deltaCalc.deltaDouble(current.get("xact_rollback"), prev.get("xact_rollback"))),
            d2l(deltaCalc.deltaDouble(current.get("blks_read"), prev.get("blks_read"))),
            d2l(deltaCalc.deltaDouble(current.get("blks_hit"), prev.get("blks_hit"))),
            d2l(deltaCalc.deltaDouble(current.get("tup_returned"), prev.get("tup_returned"))),
            d2l(deltaCalc.deltaDouble(current.get("tup_fetched"), prev.get("tup_fetched"))),
            d2l(deltaCalc.deltaDouble(current.get("tup_inserted"), prev.get("tup_inserted"))),
            d2l(deltaCalc.deltaDouble(current.get("tup_updated"), prev.get("tup_updated"))),
            d2l(deltaCalc.deltaDouble(current.get("tup_deleted"), prev.get("tup_deleted"))),
            d2l(deltaCalc.deltaDouble(current.get("conflicts"), prev.get("conflicts"))),
            d2l(deltaCalc.deltaDouble(current.get("temp_files"), prev.get("temp_files"))),
            d2l(deltaCalc.deltaDouble(current.get("temp_bytes"), prev.get("temp_bytes"))),
            d2l(deltaCalc.deltaDouble(current.get("deadlocks"), prev.get("deadlocks"))),
            d2l(deltaCalc.deltaDouble(current.get("checksum_failures"), prev.get("checksum_failures"))),
            orZeroD(deltaCalc.deltaDouble(current.get("blk_read_time"), prev.get("blk_read_time"))),
            orZeroD(deltaCalc.deltaDouble(current.get("blk_write_time"), prev.get("blk_write_time"))),
            orZeroD(deltaCalc.deltaDouble(current.get("session_time"), prev.get("session_time"))),
            orZeroD(deltaCalc.deltaDouble(current.get("active_time"), prev.get("active_time"))),
            orZeroD(deltaCalc.deltaDouble(current.get("idle_in_transaction_time"), prev.get("idle_in_transaction_time"))),
            d2lNullable(deltaCalc.deltaDouble(current.get("sessions"), prev.get("sessions"))),
            d2lNullable(deltaCalc.deltaDouble(current.get("sessions_abandoned"), prev.get("sessions_abandoned"))),
            d2lNullable(deltaCalc.deltaDouble(current.get("sessions_fatal"), prev.get("sessions_fatal"))),
            d2lNullable(deltaCalc.deltaDouble(current.get("sessions_killed"), prev.get("sessions_killed"))),
            statsReset, checksumLastFailure,
            d2lNullable(deltaCalc.deltaDouble(current.get("parallel_workers_to_launch"), prev.get("parallel_workers_to_launch"))),
            d2lNullable(deltaCalc.deltaDouble(current.get("parallel_workers_launched"), prev.get("parallel_workers_launched")))
        );
        return 1;
    }

    // -------------------------------------------------------------------------
    // Table stats
    // -------------------------------------------------------------------------

    private long collectTableStats(Connection conn, SourceQueries queries,
                                   long instancePk, long dbid,
                                   OffsetDateTime now) throws Exception {
        long rows = 0;

        // FIZIKSEL NESIL (PGSTAT-P0-046 Faz 2). Iki harita dongude BIR KEZ
        // yuklenir; tablo basina sorgu atmak on binlerce tabloda pahali olurdu.
        java.util.Map<Long, FactRepository.PhysicalState> prevPhysical =
            factRepo.loadPhysicalState(instancePk, dbid);
        java.util.Map<Long, long[]> unconfirmed =
            factRepo.loadUnconfirmedEvents(instancePk, dbid);

        try (Statement stmt = conn.createStatement();
             ResultSet rs = stmt.executeQuery(queries.tableStatsQuery())) {
            while (rs.next()) {
                long relid = rs.getLong("relid");
                String schemaname = rs.getString("schemaname");
                String relname = rs.getString("relname");

                // dim.relation_ref upsert
                dimensionRepo.upsertRelationRef(instancePk, dbid, relid,
                        schemaname, relname, "r"); // 'r' = ordinary table

                // Kumulatif degerler
                String cacheKey = instancePk + ":" + dbid + ":" + relid;
                Map<String, Long> current = new HashMap<>();
                current.put("seq_scan", rs.getLong("seq_scan"));
                current.put("seq_tup_read", rs.getLong("seq_tup_read"));
                current.put("idx_scan", rs.getLong("idx_scan"));
                current.put("idx_tup_fetch", rs.getLong("idx_tup_fetch"));
                current.put("n_tup_ins", rs.getLong("n_tup_ins"));
                current.put("n_tup_upd", rs.getLong("n_tup_upd"));
                current.put("n_tup_del", rs.getLong("n_tup_del"));
                current.put("n_tup_hot_upd", rs.getLong("n_tup_hot_upd"));
                current.put("vacuum_count", rs.getLong("vacuum_count"));
                current.put("autovacuum_count", rs.getLong("autovacuum_count"));
                current.put("analyze_count", rs.getLong("analyze_count"));
                current.put("autoanalyze_count", rs.getLong("autoanalyze_count"));
                current.put("heap_blks_read", rs.getLong("heap_blks_read"));
                current.put("heap_blks_hit", rs.getLong("heap_blks_hit"));
                current.put("idx_blks_read", rs.getLong("idx_blks_read"));
                current.put("idx_blks_hit", rs.getLong("idx_blks_hit"));
                current.put("toast_blks_read", rs.getLong("toast_blks_read"));
                current.put("toast_blks_hit", rs.getLong("toast_blks_hit"));
                current.put("tidx_blks_read", rs.getLong("tidx_blks_read"));
                current.put("tidx_blks_hit", rs.getLong("tidx_blks_hit"));

                // Gauge degerler (delta degil, anlik)
                long nLiveTup = rs.getLong("n_live_tup");
                long nDeadTup = rs.getLong("n_dead_tup");
                long nModSinceAnalyze = rs.getLong("n_mod_since_analyze");

                // Tablo-ozel autovacuum_enabled override (pg_class.reloptions,
                // V093) — dead_tuple_ratio "hic vacuum edilmemis" teshisinde
                // "override olabilir" yerine KESIN sonuc vermek icin
                // (musteri talebi 2026-08-24: "bunu da kontrol edebilirsin").
                // reloptions delta degil, nadiren degisen bir konfigurasyon —
                // ayri, kucuk bir tabloda upsert edilir (33 parametreli
                // insertTableStatDelta'ya eklenmedi, riski artirmamak icin).
                String reloptionsRaw = rs.getString("reloptions_raw");
                factRepo.upsertTableRelOptions(instancePk, dbid, relid, schemaname, relname, reloptionsRaw);

                detectPhysicalGeneration(instancePk, dbid, relid, schemaname, relname,
                    rs, now, prevPhysical, unconfirmed);

                // Yeni gauge/timestamp kolonlari (V066)
                java.time.OffsetDateTime lastVacuum = rs.getObject("last_vacuum", java.time.OffsetDateTime.class);
                java.time.OffsetDateTime lastAutovacuum = rs.getObject("last_autovacuum", java.time.OffsetDateTime.class);
                java.time.OffsetDateTime lastAnalyze = rs.getObject("last_analyze", java.time.OffsetDateTime.class);
                java.time.OffsetDateTime lastAutoanalyze = rs.getObject("last_autoanalyze", java.time.OffsetDateTime.class);
                long nInsSinceVacuum = rs.getLong("n_ins_since_vacuum");
                java.time.OffsetDateTime lastSeqScan = rs.getObject("last_seq_scan", java.time.OffsetDateTime.class);
                java.time.OffsetDateTime lastIdxScan = rs.getObject("last_idx_scan", java.time.OffsetDateTime.class);
                long nTupNewpageUpd = rs.getLong("n_tup_newpage_upd");

                // pg_class.reltuples — autovacuum'un esik hesabinda kullandigi
                // deger ve istatistik sifirlamasindan etkilenmeyen tek satir
                // sayisi tahmini (V100). PG14+'ta -1 "bilinmiyor" demek; negatif
                // ya da NULL degerleri kullanmiyoruz, tuketen taraf
                // n_live_tup_estimate'e dusuyor.
                Long reltuples = rs.getObject("reltuples", Long.class);
                if (reltuples != null && reltuples < 0) reltuples = null;

                // V067 Madde 4: PG18 vacuum/analyze time (monotonik counter → delta)
                // double precision — Map<String,Long>'a koymuyoruz, precision kaybi olur
                double totalVacuumTime = rs.getDouble("total_vacuum_time");
                double totalAutovacuumTime = rs.getDouble("total_autovacuum_time");
                double totalAnalyzeTime = rs.getDouble("total_analyze_time");
                double totalAutoanalyzeTime = rs.getDouble("total_autoanalyze_time");

                Map<String, Long> prev = previousTableStats.put(cacheKey, current);
                if (prev == null) continue; // Baseline

                // vacuum_time delta: onceki deger ayri double map'ten
                String vtKey = cacheKey + ":vt";
                double[] prevVt = previousTableVacuumTime.get(vtKey);
                double[] currVt = {totalVacuumTime, totalAutovacuumTime, totalAnalyzeTime, totalAutoanalyzeTime};
                previousTableVacuumTime.put(vtKey, currVt);

                double vtDelta0 = prevVt != null ? orZeroD(deltaCalc.deltaDouble(currVt[0], prevVt[0])) : 0;
                double vtDelta1 = prevVt != null ? orZeroD(deltaCalc.deltaDouble(currVt[1], prevVt[1])) : 0;
                double vtDelta2 = prevVt != null ? orZeroD(deltaCalc.deltaDouble(currVt[2], prevVt[2])) : 0;
                double vtDelta3 = prevVt != null ? orZeroD(deltaCalc.deltaDouble(currVt[3], prevVt[3])) : 0;

                factRepo.insertTableStatDelta(now, instancePk, dbid, relid, schemaname, relname,
                    d(prev, current, "seq_scan"), d(prev, current, "seq_tup_read"),
                    d(prev, current, "idx_scan"), d(prev, current, "idx_tup_fetch"),
                    d(prev, current, "n_tup_ins"), d(prev, current, "n_tup_upd"),
                    d(prev, current, "n_tup_del"), d(prev, current, "n_tup_hot_upd"),
                    d(prev, current, "vacuum_count"), d(prev, current, "autovacuum_count"),
                    d(prev, current, "analyze_count"), d(prev, current, "autoanalyze_count"),
                    d(prev, current, "heap_blks_read"), d(prev, current, "heap_blks_hit"),
                    d(prev, current, "idx_blks_read"), d(prev, current, "idx_blks_hit"),
                    d(prev, current, "toast_blks_read"), d(prev, current, "toast_blks_hit"),
                    d(prev, current, "tidx_blks_read"), d(prev, current, "tidx_blks_hit"),
                    nLiveTup, nDeadTup, nModSinceAnalyze,
                    lastVacuum, lastAutovacuum, lastAnalyze, lastAutoanalyze,
                    nInsSinceVacuum, lastSeqScan, lastIdxScan, nTupNewpageUpd,
                    vtDelta0, vtDelta1, vtDelta2, vtDelta3, reltuples
                );
                rows++;
            }
        }
        return rows;
    }

    // -------------------------------------------------------------------------
    // Index stats
    // -------------------------------------------------------------------------

    private long collectIndexStats(Connection conn, SourceQueries queries,
                                   long instancePk, long dbid,
                                   OffsetDateTime now) throws Exception {
        long rows = 0;

        try (Statement stmt = conn.createStatement();
             ResultSet rs = stmt.executeQuery(queries.indexStatsQuery())) {
            while (rs.next()) {
                long tableRelid = rs.getLong("table_relid");
                long indexRelid = rs.getLong("index_relid");
                String schemaname = rs.getString("schemaname");
                String tableRelname = rs.getString("table_relname");
                String indexRelname = rs.getString("index_relname");

                // dim.relation_ref upsert (index icin)
                dimensionRepo.upsertRelationRef(instancePk, dbid, indexRelid,
                        schemaname, indexRelname, "i"); // 'i' = index

                String cacheKey = instancePk + ":" + dbid + ":" + indexRelid;
                Map<String, Long> current = new HashMap<>();
                current.put("idx_scan", rs.getLong("idx_scan"));
                current.put("idx_tup_read", rs.getLong("idx_tup_read"));
                current.put("idx_tup_fetch", rs.getLong("idx_tup_fetch"));
                current.put("idx_blks_read", rs.getLong("idx_blks_read"));
                current.put("idx_blks_hit", rs.getLong("idx_blks_hit"));

                Map<String, Long> prev = previousIndexStats.put(cacheKey, current);
                if (prev == null) continue;

                // PG16+ last_idx_scan (nullable)
                java.time.OffsetDateTime lastIdxScan = rs.getObject("last_idx_scan", java.time.OffsetDateTime.class);

                factRepo.insertIndexStatDelta(now, instancePk, dbid, tableRelid, indexRelid,
                    schemaname, tableRelname, indexRelname,
                    d(prev, current, "idx_scan"), d(prev, current, "idx_tup_read"),
                    d(prev, current, "idx_tup_fetch"),
                    d(prev, current, "idx_blks_read"), d(prev, current, "idx_blks_hit"),
                    (Boolean) rs.getObject("is_valid"), (Boolean) rs.getObject("is_ready"),
                    (Boolean) rs.getObject("is_primary"), (Boolean) rs.getObject("is_unique"),
                    lastIdxScan
                );
                rows++;
            }
        }
        return rows;
    }

    // -------------------------------------------------------------------------
    // Yardimci metotlar
    // -------------------------------------------------------------------------

    /** Delta hesapla — negatifse 0 dondur. */
    private long d(Map<String, Long> prev, Map<String, Long> current, String key) {
        Long delta = deltaCalc.deltaLong(current.getOrDefault(key, 0L),
                prev.getOrDefault(key, 0L));
        return delta != null ? delta : 0L;
    }

    private long d2l(Double val) { return val != null ? val.longValue() : 0L; }
    private Long d2lNullable(Double val) { return val != null ? val.longValue() : null; }
    private double orZeroD(Double val) { return val != null ? val : 0.0; }
}
