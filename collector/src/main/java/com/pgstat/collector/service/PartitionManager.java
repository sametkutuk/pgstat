package com.pgstat.collector.service;

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
        "fact.pg_user_function_snapshot"
    };

    private static final DateTimeFormatter DATE_FMT = DateTimeFormatter.ofPattern("yyyyMMdd");
    private static final DateTimeFormatter MONTH_FMT = DateTimeFormatter.ofPattern("yyyyMM");

    private final JdbcTemplate jdbc;

    public PartitionManager(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
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

    private void ensureDailyPartitions() {
        LocalDate today = LocalDate.now();

        for (String parentTable : DAILY_FACT_TABLES) {
            Set<String> existing = findExistingPartitions(parentTable);
            String baseName = parentTable.replace(".", "_"); // fact_pgss_delta

            for (int d = 0; d <= 3; d++) {
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

    /** Partition olusturur. */
    private void createPartition(String parentTable, String partitionName,
                                 String fromDate, String toDate) {
        // Partition ismi schema.name formatinda olmali
        String[] parentParts = parentTable.split("\\.", 2);
        String schema = parentParts[0];
        String fullPartitionName = schema + "." + partitionName.replace(schema + "_", "");

        String ddl = String.format(
            "CREATE TABLE IF NOT EXISTS %s PARTITION OF %s FOR VALUES FROM ('%s') TO ('%s')",
            fullPartitionName, parentTable, fromDate, toDate
        );

        try {
            jdbc.execute(ddl);
            log.info("Partition olusturuldu: {}", fullPartitionName);
        } catch (Exception e) {
            // Partition zaten varsa veya baska hata — logla, devam et
            log.warn("Partition olusturma hatasi: {} — {}", fullPartitionName, e.getMessage());
        }
    }
}
