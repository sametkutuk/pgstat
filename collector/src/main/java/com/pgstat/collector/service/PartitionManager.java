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
 *  - hourly agg tablolari icin gelecek 2 aylik monthly partition
 *  - agg.pgss_daily icin gelecek 1 yillik yearly partition
 *
 * pg_inherits ile mevcut partition'lari tarar, eksikleri
 * CREATE TABLE ... PARTITION OF ile doldurur.
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
        "fact.pg_sequence_io_snapshot",
        // V039: Gece snapshot tablolari
        "fact.pg_settings_snapshot",
        "fact.pg_relation_size_snapshot",
        "fact.pg_sequence_state_snapshot",
        "fact.pg_database_freeze_snapshot"
    };

    /** Aylik partition gerektiren hourly aggregate tablolari */
    private static final String[] MONTHLY_AGG_TABLES = {
        "agg.pgss_hourly",
        "agg.pg_table_stat_hourly"
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
            ensureFuturePartitions();
            log.info("Startup: partition kontrolu tamamlandi.");
        } catch (Exception e) {
            log.error("Startup partition olusturma hatasi: {}", e.getMessage(), e);
        }
    }

    /**
     * Gelecek partition'larin varligini kontrol eder ve eksikleri olusturur.
     * Mevcut partition'lara dokunmaz; sadece eksik gelecek partition'lari
     * DB session timezone'undaki deterministik midnight bound'lariyla olusturur.
     */
    public void ensureFuturePartitions() {
        ensureDailyPartitions();
        ensureMonthlyPartitions();
        ensureYearlyPartitions();
    }

    // =========================================================================
    // Gunluk fact partition'lari (dun + 14 gun ileri)
    // =========================================================================

    private static final int DAILY_LOOKBEHIND_DAYS = 1;
    private static final int DAILY_LOOKAHEAD_DAYS  = 14;

    private void ensureDailyPartitions() {
        LocalDate today = LocalDate.now();

        for (String parentTable : DAILY_FACT_TABLES) {
            if (!isPartitionedTable(parentTable)) {
                log.debug("Tablo partitioned degil veya yok, atlandi: {}", parentTable);
                continue;
            }

            Set<String> existing = findExistingPartitions(parentTable);
            String baseName = parentTable.replace(".", "_");

            for (int d = -DAILY_LOOKBEHIND_DAYS; d <= DAILY_LOOKAHEAD_DAYS; d++) {
                LocalDate day = today.plusDays(d);
                String partitionName = baseName + "_" + day.format(DATE_FMT);

                if (existing.contains(partitionName)) continue;

                createPartition(parentTable, partitionName, boundsForDayOffset(d));
            }
        }
    }

    // =========================================================================
    // Aylik hourly aggregate partition'lari (2 ay ileri)
    // =========================================================================

    private void ensureMonthlyPartitions() {
        YearMonth current = YearMonth.now();

        for (String parentTable : MONTHLY_AGG_TABLES) {
            if (!isPartitionedTable(parentTable)) {
                log.debug("Tablo partitioned degil veya yok, atlandi: {}", parentTable);
                continue;
            }

            Set<String> existing = findExistingPartitions(parentTable);
            String baseName = parentTable.replace(".", "_");

            for (int m = 0; m <= 2; m++) {
                YearMonth month = current.plusMonths(m);
                String partitionName = baseName + "_" + month.format(MONTH_FMT);

                if (existing.contains(partitionName)) continue;

                createPartition(parentTable, partitionName, boundsForMonthOffset(m));
            }
        }
    }

    // =========================================================================
    // Yillik agg.pgss_daily partition'lari (1 yil ileri)
    // =========================================================================

    private void ensureYearlyPartitions() {
        String parentTable = "agg.pgss_daily";
        Set<String> existing = findExistingPartitions(parentTable);
        int currentYear = LocalDate.now().getYear();

        for (int y = 0; y <= 1; y++) {
            int year = currentYear + y;
            String partitionName = "agg_pgss_daily_" + year;

            if (existing.contains(partitionName)) continue;

            createPartition(parentTable, partitionName, boundsForYearOffset(y));
        }
    }

    // =========================================================================
    // Yardimci metotlar
    // =========================================================================

    /** pg_inherits ile mevcut partition'lari bulur. */
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

        Set<String> result = new HashSet<>();
        for (String name : names) {
            result.add(schema + "_" + name);
        }
        result.addAll(names);
        return result;
    }

    /**
     * Partition olusturur.
     *
     * Bound hesaplari DB session timezone'unda yapilir. Java sadece partition
     * ismini uretir; range timestamp'lerini kendi timezone'u ile formatlamaz.
     */
    private void createPartition(String parentTable, String partitionName, PartitionBounds bounds) {
        String[] parentParts = parentTable.split("\\.", 2);
        String schema = parentParts[0];
        String parentName = parentParts[1];
        String fullPartitionName = schema + "." + partitionName.replace(schema + "_", "");

        if (hasOverlappingPartition(schema, parentName, bounds)) {
            log.debug("Partition range mevcut partition ile cakistigi icin atlandi: {} [{} -> {})",
                fullPartitionName, bounds.lowerText(), bounds.upperText());
            return;
        }

        String ddl = String.format(
            "CREATE TABLE IF NOT EXISTS %s PARTITION OF %s FOR VALUES FROM (%s) TO (%s)",
            fullPartitionName, parentTable, bounds.lowerLiteral(), bounds.upperLiteral()
        );

        try {
            jdbc.execute(ddl);
            log.info("Partition olusturuldu: {} [{} -> {})",
                fullPartitionName, bounds.lowerText(), bounds.upperText());
        } catch (Exception e) {
            Throwable cause = e;
            while (cause.getCause() != null && cause.getCause() != cause) {
                cause = cause.getCause();
            }
            log.warn("Partition olusturma hatasi: {} - {} (gercek neden: {})",
                fullPartitionName, e.getMessage(), cause.getMessage());
        }
    }

    /**
     * DB'nin kendi session timezone'unda range bound uretir.
     * Bu sayede aggregate partition'lari Java timezone'undan etkilenmeden
     * ayni saat hizasinda kalir.
     */
    private PartitionBounds boundsForDayOffset(int offset) {
        return queryBounds("day", "1 day", offset);
    }

    private PartitionBounds boundsForMonthOffset(int offset) {
        return queryBounds("month", "1 month", offset);
    }

    private PartitionBounds boundsForYearOffset(int offset) {
        return queryBounds("year", "1 year", offset);
    }

    private PartitionBounds queryBounds(String truncUnit, String intervalUnit, int offset) {
        String sql = String.format("""
            select quote_literal(lower_bound) as lower_literal,
                   quote_literal(upper_bound) as upper_literal,
                   lower_bound::text as lower_text,
                   upper_bound::text as upper_text
            from (
                select date_trunc('%s', now() + (cast(? as int) * interval '%s')) as lower_bound,
                       date_trunc('%s', now() + ((cast(? as int) + 1) * interval '%s')) as upper_bound
            ) b
            """, truncUnit, intervalUnit, truncUnit, intervalUnit);

        Map<String, Object> row = jdbc.queryForMap(sql, offset, offset);
        return new PartitionBounds(
            String.valueOf(row.get("lower_literal")),
            String.valueOf(row.get("upper_literal")),
            String.valueOf(row.get("lower_text")),
            String.valueOf(row.get("upper_text"))
        );
    }

    /**
     * CREATE denemeden once ayni parent altinda istenen range ile cakisik bir
     * partition var mi bakar. Mevcut hatali partition'lar silinmez; sadece
     * tekrar eden overlap WARN spam'i engellenir.
     */
    private boolean hasOverlappingPartition(String schema, String parentName, PartitionBounds bounds) {
        try {
            Integer count = jdbc.queryForObject("""
                select count(*)
                from (
                    select regexp_match(
                               pg_get_expr(child.relpartbound, child.oid),
                               'FROM \\(''([^'']+)''\\) TO \\(''([^'']+)''\\)'
                           ) as bound_match
                    from pg_inherits i
                    join pg_class parent on parent.oid = i.inhparent
                    join pg_class child on child.oid = i.inhrelid
                    join pg_namespace ns on ns.oid = parent.relnamespace
                    where ns.nspname = ?
                      and parent.relname = ?
                ) p
                where p.bound_match is not null
                  and (p.bound_match)[1]::timestamptz < ?::timestamptz
                  and (p.bound_match)[2]::timestamptz > ?::timestamptz
                """, Integer.class, schema, parentName, bounds.upperText(), bounds.lowerText());
            return count != null && count > 0;
        } catch (Exception e) {
            log.debug("Partition overlap pre-check atlandi: {}.{} [{} -> {}) - {}",
                schema, parentName, bounds.lowerText(), bounds.upperText(), e.getMessage());
            return false;
        }
    }

    /**
     * Parent tablonun gercekten partitioned olup olmadigini kontrol eder.
     * Migration'lar uygulanmadiysa veya tablo yoksa false doner.
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

    private record PartitionBounds(
        String lowerLiteral,
        String upperLiteral,
        String lowerText,
        String upperText
    ) {}
}
