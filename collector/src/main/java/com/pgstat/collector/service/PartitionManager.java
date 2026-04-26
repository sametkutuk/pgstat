package com.pgstat.collector.service;

import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.time.LocalDate;
import java.time.YearMonth;
import java.time.format.DateTimeFormatter;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Partition olusturma otomasyonu.
 *
 * Rollup job her calistiginda:
 *  - fact tablolari icin gelecek 14 gunluk daily partition
 *  - agg.pgss_hourly icin gelecek 2 aylik monthly partition
 *  - agg.pgss_daily icin gelecek 1 yillik yearly partition
 *
 * pg_inherits ile mevcut partisyonlari tarar, eksikleri CREATE TABLE ... PARTITION OF ile doldurur.
 */
@Component
public class PartitionManager {

    private static final Logger log = LoggerFactory.getLogger(PartitionManager.class);

    /** Gunluk partition gerektiren fact tablolari */
    private static final String[] DAILY_FACT_TABLES = {
        "fact.pgss_delta",
        "fact.pg_database_delta",
        "fact.pg_table_stat_delta",
        "fact.pg_index_stat_delta",
        "fact.pg_cluster_delta",
        "fact.pg_io_stat_delta",
        "fact.pg_activity_snapshot",
        "fact.pg_replication_snapshot",
        "fact.pg_lock_snapshot",
        "fact.pg_progress_snapshot",
        "fact.pg_wal_snapshot",
        "fact.pg_archiver_snapshot",
        "fact.pg_replication_slot_snapshot",
        "fact.pg_database_conflict_snapshot",
        "fact.pg_slru_snapshot",
        "fact.pg_subscription_snapshot",
        "fact.pg_recovery_prefetch_snapshot",
        "fact.pg_user_function_snapshot",
        "fact.pg_sequence_io_snapshot"
    };

    private static final DateTimeFormatter DATE_FMT = DateTimeFormatter.ofPattern("yyyyMMdd");
    private static final DateTimeFormatter MONTH_FMT = DateTimeFormatter.ofPattern("yyyyMM");

    private final JdbcTemplate jdbc;

    public PartitionManager(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Collector startup'ta partition'lari hemen kontrol et.
     * Rollup job'a baglanmadan, ilk veri yazilmadan once partition'larin
     * hazir oldugundan emin olur. Boylece 'no partition found' hatalari onlenir.
     */
    @PostConstruct
    public void initOnStartup() {
        try {
            log.info("Startup: partition'lar kontrol ediliyor...");
            // Yanlis timezone ile olusturulmus partition'lari tespit edip yeniden olustur
            repairMisalignedPartitions();
            ensureFuturePartitions();
            log.info("Startup: partition kontrolu tamamlandi.");
        } catch (Exception e) {
            log.error("Startup partition olusturma hatasi: {}", e.getMessage(), e);
        }
    }

    /**
     * Onceki versiyonlardaki timezone bug'i nedeniyle yanlis range'li olusmus
     * partition'lari tespit eder, ic verisi yoksa drop eder. Boylece yeni
     * dogru range'li partition'in olusumu icin yer acilir.
     *
     * Yanlis partition: range'i UTC dilim sınırlarına denk gelmeyen (ornegin
     * '2026-04-24 21:00:00+00' gibi).
     */
    private void repairMisalignedPartitions() {
        for (String parentTable : DAILY_FACT_TABLES) {
            try {
                List<Map<String, Object>> rows = jdbc.queryForList(
                    "SELECT c.relname, pg_get_expr(c.relpartbound, c.oid) as bound " +
                    "FROM pg_inherits i " +
                    "JOIN pg_class c ON c.oid = i.inhrelid " +
                    "JOIN pg_class p ON p.oid = i.inhparent " +
                    "JOIN pg_namespace ns ON ns.oid = p.relnamespace " +
                    "WHERE ns.nspname || '.' || p.relname = ?", parentTable);

                for (Map<String, Object> row : rows) {
                    String relname = (String) row.get("relname");
                    String bound = (String) row.get("bound");
                    if (bound == null) continue;

                    // Tipik dogru range: FROM ('2026-04-25 00:00:00+00') TO ('2026-04-26 00:00:00+00')
                    // Bug'li: FROM ('2026-04-24 21:00:00+00') TO ('2026-04-25 21:00:00+00')
                    // Detect: saat 00:00 disinda baslayanlar bug'li
                    if (bound.matches(".*FROM \\('\\d{4}-\\d{2}-\\d{2} (?!00:00:00)\\d{2}:\\d{2}:\\d{2}.*")) {
                        // Icerigi var mi?
                        Long count = jdbc.queryForObject(
                            "SELECT count(*) FROM " + parentTable.split("\\.")[0] + "." + relname,
                            Long.class);
                        if (count != null && count == 0) {
                            jdbc.execute("DROP TABLE " + parentTable.split("\\.")[0] + "." + relname);
                            log.info("Yanlis range'li bos partition silindi: {}.{} (range: {})",
                                parentTable.split("\\.")[0], relname, bound);
                        } else {
                            log.warn("Yanlis range'li ama veri iceren partition: {}.{} ({} satir) — manuel inceleme gerek",
                                parentTable.split("\\.")[0], relname, count);
                        }
                    }
                }
            } catch (Exception e) {
                log.debug("Partition repair tarama hatasi {}: {}", parentTable, e.getMessage());
            }
        }
    }

    /**
     * Gelecek partisyonlarin varligini kontrol eder ve eksikleri olusturur.
     * Rollup job tarafindan her calistiginda cagirilir.
     */
    public void ensureFuturePartitions() {
        ensureDailyPartitions();
        ensureMonthlyPartitions();
        ensureYearlyPartitions();
    }

    // =========================================================================
    // Gunluk fact partisyonlari (14 gun ileri)
    // =========================================================================

    /**
     * Daily partition lookahead — dunden bugune + 14 gun ileri.
     * Genis bir pencere acmak rollup job'in birkac gun fail etmesi durumunda
     * collector'in veri yazmaya devam etmesini saglar.
     * Dun de dahil cunku timezone farklari ve ge cikan insertler icin guvenli.
     */
    private static final int DAILY_LOOKBEHIND_DAYS = 1;
    private static final int DAILY_LOOKAHEAD_DAYS  = 14;

    private void ensureDailyPartitions() {
        LocalDate today = LocalDate.now();

        for (String parentTable : DAILY_FACT_TABLES) {
            // Parent tablo gercekten partitioned mi? (V023+ tablolari migration
            // yoksa olmayabilir). Degilse bu tabloyu atla.
            if (!isPartitionedTable(parentTable)) {
                log.debug("Tablo partitioned degil veya yok, atlandi: {}", parentTable);
                continue;
            }

            Set<String> existing = findExistingPartitions(parentTable);
            String baseName = parentTable.replace(".", "_"); // fact_pgss_delta

            for (int d = -DAILY_LOOKBEHIND_DAYS; d <= DAILY_LOOKAHEAD_DAYS; d++) {
                LocalDate day = today.plusDays(d);
                String suffix = day.format(DATE_FMT);
                String partitionName = baseName + "_" + suffix;

                if (existing.contains(partitionName)) continue;

                String fromDate = day.toString(); // yyyy-MM-dd
                String toDate = day.plusDays(1).toString();

                createPartition(parentTable, partitionName, fromDate, toDate);
            }
        }
    }

    // =========================================================================
    // Aylik agg.pgss_hourly partisyonlari (2 ay ileri)
    // =========================================================================

    private void ensureMonthlyPartitions() {
        String parentTable = "agg.pgss_hourly";
        Set<String> existing = findExistingPartitions(parentTable);
        YearMonth current = YearMonth.now();

        for (int m = 0; m <= 2; m++) {
            YearMonth month = current.plusMonths(m);
            String suffix = month.format(MONTH_FMT);
            String partitionName = "agg_pgss_hourly_" + suffix;

            if (existing.contains(partitionName)) continue;

            String fromDate = month.atDay(1).toString();
            String toDate = month.plusMonths(1).atDay(1).toString();

            createPartition(parentTable, partitionName, fromDate, toDate);
        }
    }

    // =========================================================================
    // Yillik agg.pgss_daily partisyonlari (1 yil ileri)
    // =========================================================================

    private void ensureYearlyPartitions() {
        String parentTable = "agg.pgss_daily";
        Set<String> existing = findExistingPartitions(parentTable);
        int currentYear = LocalDate.now().getYear();

        for (int y = 0; y <= 1; y++) {
            int year = currentYear + y;
            String partitionName = "agg_pgss_daily_" + year;

            if (existing.contains(partitionName)) continue;

            String fromDate = year + "-01-01";
            String toDate = (year + 1) + "-01-01";

            createPartition(parentTable, partitionName, fromDate, toDate);
        }
    }

    // =========================================================================
    // Yardimci metotlar
    // =========================================================================

    /** pg_inherits ile mevcut partisyonlari bulur. */
    private Set<String> findExistingPartitions(String parentTable) {
        String[] parts = parentTable.split("\\.", 2);
        String schema = parts[0];
        String table = parts[1];

        List<String> names = jdbc.queryForList("""
            select child.relname
            from pg_inherits
            join pg_class parent on parent.oid = pg_inherits.inhparent
            join pg_class child  on child.oid  = pg_inherits.inhrelid
            join pg_namespace pns on pns.oid = parent.relnamespace
            where parent.relname = ?
              and pns.nspname = ?
            """,
            String.class,
            table, schema
        );

        // Partition isimleri schema prefix'siz doner; karsilastirma icin
        // schema_table_suffix formatina cevir
        Set<String> result = new HashSet<>();
        for (String name : names) {
            result.add(schema + "_" + name); // ornek: fact_pgss_delta_20260420
        }
        // Ayrica raw ismi de ekle (karsilastirma kolayligi icin)
        result.addAll(names);
        return result;
    }

    /**
     * Partition olusturur.
     *
     * KRITIK: Sample_ts/snapshot_ts kolonlari timestamptz tipinde. Sadece
     * '2026-04-25' yazarsak PG session timezone'da yorumlar (ornegin
     * Europe/Istanbul +3 ise '2026-04-24 21:00 UTC' olur). Bu durumda
     * partition aralik UTC veri ile uyusmaz, "no partition found" hatasi alinir.
     *
     * Cozum: timestamptz literal'i UTC suffix ile acikca yazmak:
     *   '2026-04-25 00:00:00+00'
     */
    private void createPartition(String parentTable, String partitionName,
                                 String fromDate, String toDate) {
        // Partition ismi schema.name formatinda olmali
        String[] parentParts = parentTable.split("\\.", 2);
        String schema = parentParts[0];
        String fullPartitionName = schema + "." + partitionName.replace(schema + "_", "");

        // Timestamptz icin UTC suffix ekle. Yearly partition'lar (yyyy formati)
        // yearly olarak '2026-01-01 00:00:00+00' formatina cevrilir.
        String fromTs = toUtcTimestamp(fromDate);
        String toTs   = toUtcTimestamp(toDate);

        String ddl = String.format(
            "CREATE TABLE IF NOT EXISTS %s PARTITION OF %s FOR VALUES FROM ('%s') TO ('%s')",
            fullPartitionName, parentTable, fromTs, toTs
        );

        try {
            jdbc.execute(ddl);
            log.info("Partition olusturuldu: {} [{} → {})", fullPartitionName, fromTs, toTs);
        } catch (Exception e) {
            // Spring "bad SQL grammar" ile sariyor — gercek PG nedenini bul
            Throwable cause = e;
            while (cause.getCause() != null && cause.getCause() != cause) {
                cause = cause.getCause();
            }
            log.warn("Partition olusturma hatasi: {} — {} (gercek neden: {})",
                    fullPartitionName, e.getMessage(), cause.getMessage());
        }
    }

    /**
     * Parent tablonun gercekten partitioned olup olmadigini kontrol eder.
     * V023+ migration'lar uygulanmadiysa veya tablo yoksa false doner.
     */
    private boolean isPartitionedTable(String parentTable) {
        try {
            String[] parts = parentTable.split("\\.", 2);
            String schema = parts[0];
            String table = parts[1];
            Integer count = jdbc.queryForObject(
                "SELECT count(*) FROM pg_class c " +
                "JOIN pg_namespace n ON n.oid = c.relnamespace " +
                "WHERE n.nspname = ? AND c.relname = ? AND c.relkind = 'p'",
                Integer.class, schema, table);
            return count != null && count > 0;
        } catch (Exception e) {
            return false;
        }
    }

    /** "2026-04-25" → "2026-04-25 00:00:00+00", "2026" → "2026-01-01 00:00:00+00" */
    private static String toUtcTimestamp(String dateOrYear) {
        if (dateOrYear.length() == 4) {
            // Yearly format: "2026" → "2026-01-01 00:00:00+00"
            return dateOrYear + "-01-01 00:00:00+00";
        }
        return dateOrYear + " 00:00:00+00";
    }
}
