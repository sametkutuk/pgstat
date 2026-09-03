package com.pgstat.collector.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;

/**
 * Retention enforcement — partition drop + instance bazli batched delete.
 *
 * Calisma mantigi:
 *  1. RAW fact tablolari icin:
 *     - Her instance'in raw_retention_days cutoff'unu bul
 *     - Global hard drop (en uzun retention) sinirinin gerisindeki partisyonlari DROP
 *     - Arada kalan aralikta instance bazli batched DELETE
 *  2. SNAPSHOT tablolari icin saat bazli retention (cok daha kisa)
 *  3. hourly/daily agg tablolari icin ay bazli partition drop
 *  4. ops tablolarinda policy bazli gunluk temizlik
 */
@Component
public class PurgeEvaluator {

    private static final Logger log = LoggerFactory.getLogger(PurgeEvaluator.class);

    private static final int DELETE_BATCH_SIZE = 10_000;

    /** Ham delta tablolari — sample_ts kullanir, day-bazli partition */
    private static final String[] DELTA_FACT_TABLES = {
        "fact.pgss_delta",
        "fact.pg_database_delta",
        "fact.pg_table_stat_delta",
        "fact.pg_index_stat_delta",
        "fact.pg_cluster_delta",
        "fact.pg_io_stat_delta"
    };

    /** Snapshot tablolari — snapshot_ts/sample_ts kullanir, hacmi cok buyuk oldugu icin ayri retention */
    private static final String[] SNAPSHOT_FACT_TABLES = {
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
        // V067: wal receiver + progress snapshot tablolari — hepsi sample_ts kullanir (P0-022)
        "fact.pg_wal_receiver_snapshot",
        "fact.pg_progress_vacuum_snapshot",
        "fact.pg_progress_analyze_snapshot",
        "fact.pg_progress_create_index_snapshot",
        "fact.pg_progress_basebackup_snapshot",
        "fact.pg_progress_copy_snapshot",
        "fact.pg_progress_cluster_snapshot"
    };

    private static final String[] HOURLY_AGG_TABLES = {
        "agg.pgss_hourly",
        "agg.pg_table_stat_hourly"
    };

    /** Gece (nightly) snapshot tablolari — gunde 1 kez toplanir, rollup edilmez,
     *  nightly_snapshot_retention_days ile purge edilir (V083). snapshot_ts kullanir. */
    private static final String[] NIGHTLY_SNAPSHOT_TABLES = {
        "fact.pg_settings_snapshot",
        "fact.pg_relation_size_snapshot",
        "fact.pg_sequence_state_snapshot",
        "fact.pg_database_freeze_snapshot"
    };

    private final JdbcTemplate jdbc;

    public PurgeEvaluator(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public void evaluate() {
        purgeRawDeltaFacts();
        purgeSnapshotFacts();
        purgeTableFreezeFacts();
        purgeNightlySnapshotFacts();
        purgeHourlyAgg();
        purgeDailyAgg();
    }

    // =========================================================================
    // RAW DELTA fact tablolari (day-bazli retention)
    // =========================================================================

    private void purgeRawDeltaFacts() {
        // Instance bazli cutoff (yeni gun-bazli kolon)
        List<Map<String, Object>> instanceCutoffs = jdbc.queryForList("""
            select
              i.instance_pk,
              (current_date - coalesce(p.raw_retention_days, p.raw_retention_months * 30))::date as keep_from
            from control.instance_inventory i
            join control.retention_policy p on p.retention_policy_id = i.retention_policy_id
            where i.is_active and p.is_active and p.purge_enabled
            """);

        if (instanceCutoffs.isEmpty()) return;

        // Hard drop siniri = kullanilan politikalar arasindaki en uzun retention
        LocalDate hardDropBefore = longestUsedRetentionCutoff(
            "coalesce(p.raw_retention_days, p.raw_retention_months * 30)");
        if (hardDropBefore == null) return;

        log.info("Raw delta fact purge: hard drop siniri = {}", hardDropBefore);

        // Partition drop
        for (String table : DELTA_FACT_TABLES) {
            dropPartitionsBefore(table, hardDropBefore);
        }

        // Instance bazli batched delete (arada kalan aralikta)
        for (Map<String, Object> row : instanceCutoffs) {
            long instancePk = ((Number) row.get("instance_pk")).longValue();
            java.sql.Date keepFromSql = (java.sql.Date) row.get("keep_from");
            LocalDate instanceKeepFrom = keepFromSql.toLocalDate();

            if (instanceKeepFrom.isAfter(hardDropBefore)) {
                for (String table : DELTA_FACT_TABLES) {
                    batchedDeleteForInstance(table, "sample_ts", instancePk,
                        hardDropBefore, instanceKeepFrom);
                }
            }
        }
    }

    // =========================================================================
    // SNAPSHOT fact tablolari (saat-bazli retention — cok kisa)
    // =========================================================================

    private void purgeSnapshotFacts() {
        // Snapshot retention saat cinsinden — day partition drop yetmez,
        // timestamp-bazli DELETE yapmamiz lazim.
        // Once her instance icin cutoff bul.
        List<Map<String, Object>> instanceCutoffs = jdbc.queryForList("""
            select
              i.instance_pk,
              now() - make_interval(hours => coalesce(p.snapshot_retention_hours, 48)) as keep_from
            from control.instance_inventory i
            join control.retention_policy p on p.retention_policy_id = i.retention_policy_id
            where i.is_active and p.is_active and p.purge_enabled
            """);

        if (instanceCutoffs.isEmpty()) return;

        // Hard drop siniri (kullanilan politikalardaki en uzun snapshot retention)
        // Not: gun-bazli partition ile saat-bazli retention arasinda 1 gun
        // guvenlik payi birakilir (orijinal davranis korundu: -1 gun geri).
        LocalDate hardDropBefore = longestUsedRetentionCutoff(
            "ceil(coalesce(p.snapshot_retention_hours, 48) / 24.0)::int - 1");

        if (hardDropBefore != null) {
            log.info("Snapshot fact purge: partition drop siniri = {}", hardDropBefore);
            for (String table : SNAPSHOT_FACT_TABLES) {
                dropPartitionsBefore(table, hardDropBefore);
            }
        }

        // Saat hassasiyetinde batched delete
        for (Map<String, Object> row : instanceCutoffs) {
            long instancePk = ((Number) row.get("instance_pk")).longValue();
            java.sql.Timestamp ts = (java.sql.Timestamp) row.get("keep_from");
            OffsetDateTime keepFrom = ts.toInstant().atOffset(java.time.ZoneOffset.UTC);

            for (String table : SNAPSHOT_FACT_TABLES) {
                // Cogu yeni tablo sample_ts kullaniyor; sadece eski snapshot tablolari snapshot_ts
                String tsCol = (table.endsWith("_activity_snapshot")
                             || table.endsWith("_replication_snapshot")
                             || table.endsWith("_lock_snapshot")
                             || table.endsWith("_progress_snapshot"))
                    ? "snapshot_ts" : "sample_ts";
                batchedDeleteByTimestamp(table, tsCol, instancePk, keepFrom);
            }
        }
    }

    // =========================================================================
    // Per-table freeze facts (day-bazli retention, V078)
    // =========================================================================

    private void purgeTableFreezeFacts() {
        try {
            LocalDate hardDropBefore = longestUsedRetentionCutoff(
                "coalesce(p.table_freeze_retention_days, 90)");
            if (hardDropBefore == null) return;

            log.info("Table freeze fact purge: hard drop siniri = {}", hardDropBefore);
            dropPartitionsBefore("fact.pg_table_freeze_snapshot", hardDropBefore);

            // Instance bazli batched delete
            List<Map<String, Object>> instanceCutoffs = jdbc.queryForList("""
                select
                  i.instance_pk,
                  (current_date - coalesce(p.table_freeze_retention_days, 90))::date as keep_from
                from control.instance_inventory i
                join control.retention_policy p on p.retention_policy_id = i.retention_policy_id
                where i.is_active and p.is_active and p.purge_enabled
                """);

            for (Map<String, Object> row : instanceCutoffs) {
                long instancePk = ((Number) row.get("instance_pk")).longValue();
                java.sql.Date keepFromSql = (java.sql.Date) row.get("keep_from");
                LocalDate instanceKeepFrom = keepFromSql.toLocalDate();
                if (instanceKeepFrom.isAfter(hardDropBefore)) {
                    batchedDeleteForInstance("fact.pg_table_freeze_snapshot", "snapshot_ts",
                        instancePk, hardDropBefore, instanceKeepFrom);
                }
            }
        } catch (Exception e) {
            log.warn("Table freeze fact purge hatasi: {}", e.getMessage());
        }
    }

    // =========================================================================
    // Gece (nightly) snapshot facts — gun-bazli retention (V083)
    // pg_settings/pg_relation_size/pg_sequence_state/pg_database_freeze snapshot.
    // Gunde 1 kez toplanir -> rollup yok, sadece nightly_snapshot_retention_days
    // ile purge. Pattern purgeTableFreezeFacts ile ayni.
    // =========================================================================

    private void purgeNightlySnapshotFacts() {
        try {
            LocalDate hardDropBefore = longestUsedRetentionCutoff(
                "coalesce(p.nightly_snapshot_retention_days, 180)");
            if (hardDropBefore == null) return;

            log.info("Nightly snapshot fact purge: hard drop siniri = {}", hardDropBefore);
            for (String table : NIGHTLY_SNAPSHOT_TABLES) {
                dropPartitionsBefore(table, hardDropBefore);
            }

            // Instance bazli batched delete (hard drop sonrasi kalan artiklar icin)
            List<Map<String, Object>> instanceCutoffs = jdbc.queryForList("""
                select
                  i.instance_pk,
                  (current_date - coalesce(p.nightly_snapshot_retention_days, 180))::date as keep_from
                from control.instance_inventory i
                join control.retention_policy p on p.retention_policy_id = i.retention_policy_id
                where i.is_active and p.is_active and p.purge_enabled
                """);

            for (Map<String, Object> row : instanceCutoffs) {
                long instancePk = ((Number) row.get("instance_pk")).longValue();
                java.sql.Date keepFromSql = (java.sql.Date) row.get("keep_from");
                LocalDate instanceKeepFrom = keepFromSql.toLocalDate();
                if (instanceKeepFrom.isAfter(hardDropBefore)) {
                    for (String table : NIGHTLY_SNAPSHOT_TABLES) {
                        batchedDeleteForInstance(table, "snapshot_ts",
                            instancePk, hardDropBefore, instanceKeepFrom);
                    }
                }
            }
        } catch (Exception e) {
            log.warn("Nightly snapshot fact purge hatasi: {}", e.getMessage());
        }
    }

    // =========================================================================
    // Hourly/daily aggregate purge
    // =========================================================================

    private void purgeHourlyAgg() {
        LocalDate dropBefore = longestUsedRetentionCutoff(
            "coalesce(p.hourly_retention_days, p.hourly_retention_months * 30)");
        if (dropBefore == null) return;

        log.info("Hourly agg purge: drop siniri = {}", dropBefore);
        for (String table : HOURLY_AGG_TABLES) {
            dropPartitionsBefore(table, dropBefore);
        }
    }

    private void purgeDailyAgg() {
        LocalDate dropBefore = longestUsedRetentionCutoff(
            "coalesce(p.daily_retention_days, p.daily_retention_months * 30)");
        if (dropBefore == null) return;

        log.info("Daily agg purge: drop siniri = {}", dropBefore);
        dropPartitionsBefore("agg.pgss_daily", dropBefore);
    }

    // =========================================================================
    // Yardimci metotlar
    // =========================================================================

    /**
     * Partition drop siniri = en uzun retention — ama SADECE gercekten
     * kullanilan politikalar arasindan.
     *
     * Neden instance_inventory'ye JOIN: retention_policy tablosunda hicbir
     * aktif instance'in kullanmadigi politikalar da duruyor (ileride
     * kullanilmak uzere tanimli birakiliyorlar — bu dogru bir kullanim).
     * Eski hali sadece "p.is_active and p.purge_enabled" filtreliyordu, yani
     * bos duran bir politika da max()'a giriyordu.
     *
     * Somut sonuc (2026-08-27, uretim): 25 instance'in 24'u r3-short (7 gun),
     * 1'i r6-default (14 gun) kullaniyordu; r12-long (30 gun) hicbir instance
     * tarafindan kullanilmiyordu ama aktif oldugu icin max() 30 donuyordu.
     * Partition'lar 14 gun yerine 30 gun duruyordu. Bu partition'larda
     * instance bazli DELETE calistigi icin satirlar siliniyor, ama partition
     * durdugu ve o gune bir daha yazilmadigi icin bosalan sayfalar OS'a geri
     * donmuyordu (autovacuum sadece "yeniden kullanilabilir" isaretler).
     * pgstattuple olcumu: pgss_delta partition'larinda ~%30-45 bos alan,
     * toplam ~3 GB. Manuel VACUUM FULL disinda geri alinamiyordu.
     *
     * @param retentionExpr max() icine girecek SQL ifadesi (ornegin
     *                      "coalesce(p.raw_retention_days, p.raw_retention_months * 30)")
     * @return drop siniri; hic aktif instance/politika yoksa null
     */
    private LocalDate longestUsedRetentionCutoff(String retentionExpr) {
        return jdbc.queryForObject(
            "select (current_date - max(" + retentionExpr + "))::date" +
            "  from control.instance_inventory i" +
            "  join control.retention_policy p" +
            "    on p.retention_policy_id = i.retention_policy_id" +
            " where i.is_active and p.is_active and p.purge_enabled",
            LocalDate.class
        );
    }

    /** Belirtilen tarihten onceki partisyonlari DETACH + DROP eder. */
    private void dropPartitionsBefore(String parentTable, LocalDate beforeDate) {
        String[] parts = parentTable.split("\\.", 2);
        String schema = parts[0];
        String table = parts[1];

        List<Map<String, Object>> partitions = jdbc.queryForList("""
            select
              nmsp.nspname || '.' || child.relname as full_name,
              pg_get_expr(child.relpartbound, child.oid) as bounds
            from pg_inherits
            join pg_class parent on parent.oid = pg_inherits.inhparent
            join pg_class child  on child.oid  = pg_inherits.inhrelid
            join pg_namespace nmsp on nmsp.oid = child.relnamespace
            where parent.relname = ?
              and parent.relnamespace = (select oid from pg_namespace where nspname = ?)
            """,
            table, schema
        );

        for (Map<String, Object> partition : partitions) {
            String fullName = (String) partition.get("full_name");
            String bounds = (String) partition.get("bounds");
            LocalDate partStart = extractStartDate(bounds);
            if (partStart == null) continue;

            if (partStart.isBefore(beforeDate)) {
                try {
                    jdbc.execute("ALTER TABLE " + parentTable + " DETACH PARTITION " + fullName);
                    jdbc.execute("DROP TABLE " + fullName);
                    log.info("Partition drop edildi: {}", fullName);
                } catch (Exception e) {
                    log.warn("Partition drop hatasi: {} — {}", fullName, e.getMessage());
                }
            }
        }
    }

    private LocalDate extractStartDate(String bounds) {
        if (bounds == null) return null;
        try {
            int fromIdx = bounds.indexOf("'");
            int toIdx = bounds.indexOf("'", fromIdx + 1);
            if (fromIdx < 0 || toIdx < 0) return null;
            String dateStr = bounds.substring(fromIdx + 1, toIdx);
            if (dateStr.length() > 10) dateStr = dateStr.substring(0, 10);
            return LocalDate.parse(dateStr);
        } catch (Exception e) {
            return null;
        }
    }

    /** Instance bazli batched delete (day-araligi). */
    private void batchedDeleteForInstance(String parentTable, String tsColumn,
                                          long instancePk,
                                          LocalDate fromDate, LocalDate toDate) {
        int totalDeleted = 0;
        int deleted;
        do {
            deleted = jdbc.update(
                "delete from " + parentTable +
                " where ctid in (" +
                "  select ctid from " + parentTable +
                "  where " + tsColumn + " >= ?::date" +
                "    and " + tsColumn + " < ?::date" +
                "    and instance_pk = ?" +
                "  limit ?" +
                ")",
                fromDate, toDate, instancePk, DELETE_BATCH_SIZE
            );
            totalDeleted += deleted;
        } while (deleted >= DELETE_BATCH_SIZE);

        if (totalDeleted > 0) {
            log.info("Batched delete: {} — instance_pk={}, {} satir silindi",
                parentTable, instancePk, totalDeleted);
        }
    }

    /** Saat-hassasiyetli batched delete (snapshot tablolari icin). */
    private void batchedDeleteByTimestamp(String parentTable, String tsColumn,
                                          long instancePk, OffsetDateTime keepFrom) {
        int totalDeleted = 0;
        int deleted;
        do {
            deleted = jdbc.update(
                "delete from " + parentTable +
                " where ctid in (" +
                "  select ctid from " + parentTable +
                "  where " + tsColumn + " < ?" +
                "    and instance_pk = ?" +
                "  limit ?" +
                ")",
                keepFrom, instancePk, DELETE_BATCH_SIZE
            );
            totalDeleted += deleted;
        } while (deleted >= DELETE_BATCH_SIZE);

        if (totalDeleted > 0) {
            log.info("Snapshot batched delete: {} — instance_pk={}, {} satir silindi",
                parentTable, instancePk, totalDeleted);
        }
    }

    // =========================================================================
    // Job run history cleanup — 30g üstü eski kayıtları siler
    // =========================================================================

    /**
     * ops.job_run ve ops.job_run_instance tablolarından eski kayıtları temizler.
     * Günde 1 kez (UTC 02:00) JobOrchestrator tarafından çağrılır.
     * Batch halinde siler — ilk çalışmada çok satır birikmiş olabilir.
     */
    public void purgeJobRunHistory() {
        try {
            // Retention süresini policy'den oku (ilk aktif policy)
            int retentionDays = 30;
            try {
                Integer configured = jdbc.queryForObject(
                    "select job_run_retention_days from control.retention_policy where is_active limit 1",
                    Integer.class);
                if (configured != null && configured > 0) retentionDays = configured;
            } catch (Exception e) {
                // Kolon henüz yoksa (V037 uygulanmamış) veya satır yoksa default kullan
            }

            String interval = retentionDays + " days";

            // Batch halinde sil — çok büyük tablolarda tek DELETE lock tutar
            int totalInstDeleted = 0;
            int totalRunDeleted = 0;
            int deleted;

            // Önce child tablo (FK bağımlılığı)
            do {
                deleted = jdbc.update(
                    "delete from ops.job_run_instance where ctid in (" +
                    "  select i.ctid from ops.job_run_instance i" +
                    "  join ops.job_run r on r.job_run_id = i.job_run_id" +
                    "  where r.started_at < now() - ?::interval" +
                    "  limit 10000)",
                    interval);
                totalInstDeleted += deleted;
            } while (deleted >= 10000);

            // Sonra parent tablo
            do {
                deleted = jdbc.update(
                    "delete from ops.job_run where ctid in (" +
                    "  select ctid from ops.job_run" +
                    "  where started_at < now() - ?::interval" +
                    "  limit 10000)",
                    interval);
                totalRunDeleted += deleted;
            } while (deleted >= 10000);

            if (totalRunDeleted > 0 || totalInstDeleted > 0) {
                log.info("Job run cleanup: {} job_run + {} job_run_instance silindi (>{} gün)",
                    totalRunDeleted, totalInstDeleted, retentionDays);

                // DELETE sonrasi VACUUM: dead tuple'lari temizler (bloat onlenir) ve
                // freeze yapar (XID age birikmesini engeller). Snapshot fact'leri partition
                // drop ile temizlendigi icin vacuum gerektirmez; ops.job_run* ise DELETE
                // aldigindan bu iki tablo zamanla siser ve datfrozenxid_age artardi.
                // FREEZE + ANALYZE birlikte: hem XID wraparound riskini dusurur hem
                // planner istatistigini tazeler. VACUUM transaction blogu disinda calismali,
                // jdbc.execute autocommit modda calistirir.
                vacuumQuietly("vacuum (freeze, analyze) ops.job_run_instance");
                vacuumQuietly("vacuum (freeze, analyze) ops.job_run");
            }
        } catch (Exception e) {
            log.warn("Job run cleanup hatasi: {}", e.getMessage());
        }
    }

    /**
     * ops.audit_log instance bazli degil; global bir tablo oldugu icin tum
     * policy'ler arasindaki en kisa retention kullanilir.
     */
    public void purgeAuditLog() {
        try {
            Integer retentionDays = jdbc.queryForObject("""
                select coalesce(min(audit_log_retention_days), 90)
                from control.retention_policy
                """, Integer.class);
            int days = retentionDays != null && retentionDays > 0 ? retentionDays : 90;

            int deleted = jdbc.update("""
                delete from ops.audit_log
                where occurred_at < now() - make_interval(days => ?)
                """, days);

            if (deleted > 0) {
                log.info("Audit log purge: {} satir silindi ({} gun)", deleted, days);
            }
        } catch (Exception e) {
            log.warn("Audit log purge hatasi: {}", e.getMessage());
        }
    }

    /**
     * Sadece kapanmis alert kayitlari silinir; acik/acknowledged alert'lerin
     * gecmisi incident state'i icin tutulur.
     */
    public void purgeAlerts() {
        try {
            Integer retentionDays = jdbc.queryForObject("""
                select coalesce(min(alert_retention_days), 90)
                from control.retention_policy
                """, Integer.class);
            int days = retentionDays != null && retentionDays > 0 ? retentionDays : 90;

            int deleted = jdbc.update("""
                delete from ops.alert
                where resolved_at is not null
                  and resolved_at < now() - make_interval(days => ?)
                """, days);

            if (deleted > 0) {
                log.info("Alert purge: {} satir silindi ({} gun)", deleted, days);
            }

            // Kapanmis ihlal epizotlari da ayni retention ile silinir (V114).
            // Yeni bir ayar dugmesi eklenmedi: alarm ve epizot ayni olgunun iki
            // gorunumu, farkli sureler tutmak ikisini tutarsiz birakirdi.
            // ACIK epizotlar SILINMEZ — kapanmamis bir ihlalin gecmisi durumun
            // kendisidir. Purge bu surumde geliyor; sonraya birakilan bir
            // temizlik, buyuyen bir tablo demektir.
            int episodesDeleted = jdbc.update("""
                delete from ops.alert_episode
                where closed_at is not null
                  and closed_at < now() - make_interval(days => ?)
                """, days);

            if (episodesDeleted > 0) {
                log.info("Alert epizot purge: {} satir silindi ({} gun)", episodesDeleted, days);
            }
        } catch (Exception e) {
            log.warn("Alert purge hatasi: {}", e.getMessage());
        }
    }

    /** VACUUM calistirir; hata olursa cleanup akisini bozmaz (sadece loglar). */
    private void vacuumQuietly(String sql) {
        try {
            jdbc.execute(sql);
        } catch (Exception e) {
            log.warn("Job run vacuum hatasi ({}): {}", sql, e.getMessage());
        }
    }

    /**
     * Rapor tarihçesi ve eski notification_log kayıtlarını temizler.
     * Retention süreleri control.report_config tablosundan okunur (UI'da duzenlenebilir):
     *   - daily_retention_days
     *   - weekly_retention_days
     *   - notification_log_retention_days
     * Günde 1 kez (UTC 02:00) JobOrchestrator tarafından çağrılır.
     */
    public void purgeReportsAndNotifications() {
        // Config'i oku — yoksa safe defaults kullan
        int dailyDays = 30;
        int weeklyDays = 90;
        int notifDays = 14;
        try {
            java.util.Map<String, Object> cfg = jdbc.queryForMap(
                "select daily_retention_days, weekly_retention_days, " +
                "       notification_log_retention_days " +
                "from control.report_config where config_id = 1");
            if (cfg.get("daily_retention_days") instanceof Number n) dailyDays = n.intValue();
            if (cfg.get("weekly_retention_days") instanceof Number n) weeklyDays = n.intValue();
            if (cfg.get("notification_log_retention_days") instanceof Number n) notifDays = n.intValue();
        } catch (Exception ignore) {
            // V045 henuz uygulanmamissa default kullan
        }

        // Daily report history
        try {
            int n = jdbc.update(
                "delete from ops.report_history " +
                "where report_type = 'daily' and generated_at < now() - make_interval(days => ?)",
                dailyDays);
            if (n > 0) log.info("Eski gunluk rapor temizlendi: {} satir (>{} gun)", n, dailyDays);
        } catch (Exception e) {
            log.debug("report_history daily purge atlandi: {}", e.getMessage());
        }

        // Weekly report history
        try {
            int n = jdbc.update(
                "delete from ops.report_history " +
                "where report_type = 'weekly' and generated_at < now() - make_interval(days => ?)",
                weeklyDays);
            if (n > 0) log.info("Eski haftalik rapor temizlendi: {} satir (>{} gun)", n, weeklyDays);
        } catch (Exception e) {
            log.debug("report_history weekly purge atlandi: {}", e.getMessage());
        }

        // Notification log
        try {
            int n = jdbc.update(
                "delete from ops.notification_log where sent_at < now() - make_interval(days => ?)",
                notifDays);
            if (n > 0) log.info("Eski notification_log temizlendi: {} satir (>{} gun)", n, notifDays);
        } catch (Exception e) {
            log.debug("notification_log purge atlandi: {}", e.getMessage());
        }

        try {
            int n = jdbc.update(
                "delete from control.telegram_message_map where sent_at < now() - make_interval(days => ?)",
                7);
            if (n > 0) log.info("Eski telegram_message_map temizlendi: {} satir (>7 gun)", n);
        } catch (Exception e) {
            log.debug("telegram_message_map purge atlandi: {}", e.getMessage());
        }
    }

    /**
     * Snapshot tabloları için hourly rollup + raw temizlik.
     * 24 saat öncesine kadar olan raw kayıtları saatlik özetleyip agg tablolarına
     * yazar, sonra raw'ı siler. UTC 02:00 daily cleanup'tan çağrılır.
     *
     * Şu an WAL ve Archiver için. Diğer snapshot'lar (activity/lock/slru/replication)
     * için Kiro'ya bırakıldı — pattern aynı.
     */
    public void rollupSnapshotsHourly() {
        // PENCERE = son 26 saat. Gunde 1 kez (UTC 02:00) calisir; 24h + 2h emniyet payi.
        // ESKIDEN 48h idi -> her gun ~1.5M activity satirini bastan tarayip group by
        // yapiyordu (not exists ile cogu atiliyordu ama TARANMASI 28-43dk suruyordu,
        // poll thread'ini bloklayip collector_stale + DB time spike yaratiyordu).
        // 26h tarama hacmini ~yariya indirir; not exists zaten islenmis saatleri atlar.
        // === WAL hourly rollup ===
        try {
            int rolledUp = jdbc.update("""
                insert into agg.pg_wal_hourly (hour_ts, instance_pk, sample_count,
                    wal_bytes_total, wal_directory_size_avg, wal_file_count_avg)
                select date_trunc('hour', sample_ts) as hour_ts,
                       instance_pk,
                       count(*)::int as sample_count,
                       sum(period_wal_size_byte)::bigint as wal_bytes_total,
                       avg(wal_directory_size_byte)::bigint as wal_directory_size_avg,
                       avg(wal_file_count)::int as wal_file_count_avg
                from fact.pg_wal_snapshot
                where sample_ts < now() - interval '1 hour'
                  and sample_ts >= now() - interval '26 hours'
                  and not exists (
                    select 1 from agg.pg_wal_hourly h
                    where h.hour_ts = date_trunc('hour', fact.pg_wal_snapshot.sample_ts)
                      and h.instance_pk = fact.pg_wal_snapshot.instance_pk
                  )
                group by 1, 2
                on conflict (hour_ts, instance_pk) do nothing
                """);
            if (rolledUp > 0) log.info("WAL hourly rollup: {} satır", rolledUp);
        } catch (Exception e) {
            log.warn("WAL hourly rollup hatası: {}", e.getMessage());
        }

        // === Archiver hourly rollup ===
        try {
            int rolledUp = jdbc.update("""
                insert into agg.pg_archiver_hourly (hour_ts, instance_pk, sample_count,
                    archived_count_max, failed_count_max, last_archived_wal, last_failed_wal)
                select date_trunc('hour', sample_ts) as hour_ts,
                       instance_pk,
                       count(*)::int,
                       max(archived_count)::bigint,
                       max(failed_count)::bigint,
                       (array_agg(last_archived_wal order by sample_ts desc))[1],
                       (array_agg(last_failed_wal order by sample_ts desc))[1]
                from fact.pg_archiver_snapshot
                where sample_ts < now() - interval '1 hour'
                  and sample_ts >= now() - interval '26 hours'
                  and not exists (
                    select 1 from agg.pg_archiver_hourly h
                    where h.hour_ts = date_trunc('hour', fact.pg_archiver_snapshot.sample_ts)
                      and h.instance_pk = fact.pg_archiver_snapshot.instance_pk
                  )
                group by 1, 2
                on conflict (hour_ts, instance_pk) do nothing
                """);
            if (rolledUp > 0) log.info("Archiver hourly rollup: {} satır", rolledUp);
        } catch (Exception e) {
            log.warn("Archiver hourly rollup hatası: {}", e.getMessage());
        }

        // === Activity hourly rollup (state bazlı sayım + max duration) ===
        try {
            int n = jdbc.update("""
                insert into agg.pg_activity_hourly
                  (hour_ts, instance_pk, sample_count, active_count_max, idle_count_max,
                   idle_in_tx_count_max, waiting_count_max, total_sessions_max,
                   max_query_duration_seconds, max_xact_duration_seconds)
                select date_trunc('hour', snapshot_ts) as hour_ts, instance_pk,
                       count(distinct snapshot_ts)::int as sample_count,
                       max(active_count)::int, max(idle_count)::int,
                       max(idle_in_tx_count)::int, max(waiting_count)::int,
                       max(total_sessions)::int,
                       max(max_query_duration_seconds)::int,
                       max(max_xact_duration_seconds)::int
                from (
                  select snapshot_ts, instance_pk,
                    count(*) filter (where state = 'active') as active_count,
                    count(*) filter (where state = 'idle') as idle_count,
                    count(*) filter (where state = 'idle in transaction') as idle_in_tx_count,
                    count(*) filter (where wait_event is not null) as waiting_count,
                    count(*) as total_sessions,
                    extract(epoch from coalesce(now() - min(query_start), '0'::interval))::int as max_query_duration_seconds,
                    extract(epoch from coalesce(now() - min(xact_start), '0'::interval))::int as max_xact_duration_seconds
                  from fact.pg_activity_snapshot
                  where snapshot_ts < now() - interval '1 hour'
                    and snapshot_ts >= now() - interval '26 hours'
                    and backend_type = 'client backend'
                  group by snapshot_ts, instance_pk
                ) per_sample
                where not exists (
                  select 1 from agg.pg_activity_hourly h
                  where h.hour_ts = date_trunc('hour', per_sample.snapshot_ts)
                    and h.instance_pk = per_sample.instance_pk)
                group by 1, 2
                on conflict (hour_ts, instance_pk) do nothing
                """);
            if (n > 0) log.info("Activity hourly rollup: {} satır", n);
        } catch (Exception e) {
            log.warn("Activity hourly rollup hatası: {}", e.getMessage());
        }

        // === Lock hourly rollup (waiting count + max wait duration) ===
        try {
            int n = jdbc.update("""
                insert into agg.pg_lock_hourly
                  (hour_ts, instance_pk, sample_count, waiting_locks_max, granted_locks_max, max_wait_seconds)
                select date_trunc('hour', snapshot_ts), instance_pk,
                       count(distinct snapshot_ts)::int,
                       max(waiting)::int, max(granted)::int,
                       max(wait_sec)::int
                from (
                  select snapshot_ts, instance_pk,
                    count(*) filter (where not granted) as waiting,
                    count(*) filter (where granted) as granted,
                    extract(epoch from coalesce(now() - min(waitstart), '0'::interval))::int as wait_sec
                  from fact.pg_lock_snapshot
                  where snapshot_ts < now() - interval '1 hour'
                    and snapshot_ts >= now() - interval '26 hours'
                  group by snapshot_ts, instance_pk
                ) per_sample
                where not exists (
                  select 1 from agg.pg_lock_hourly h
                  where h.hour_ts = date_trunc('hour', per_sample.snapshot_ts)
                    and h.instance_pk = per_sample.instance_pk)
                group by 1, 2
                on conflict (hour_ts, instance_pk) do nothing
                """);
            if (n > 0) log.info("Lock hourly rollup: {} satır", n);
        } catch (Exception e) {
            log.warn("Lock hourly rollup hatası: {}", e.getMessage());
        }

        // === Replication hourly rollup (max lag) ===
        try {
            int n = jdbc.update("""
                insert into agg.pg_replication_hourly
                  (hour_ts, instance_pk, sample_count, standby_count_max,
                   max_replay_lag_bytes, max_replay_lag_seconds)
                select date_trunc('hour', snapshot_ts), instance_pk,
                       count(distinct snapshot_ts)::int,
                       max(standby_cnt)::int, max(lag_bytes)::bigint, max(lag_sec)::numeric
                from (
                  select snapshot_ts, instance_pk,
                    count(*) as standby_cnt,
                    max(replay_lag_bytes) as lag_bytes,
                    extract(epoch from max(replay_lag)) as lag_sec
                  from fact.pg_replication_snapshot
                  where snapshot_ts < now() - interval '1 hour'
                    and snapshot_ts >= now() - interval '26 hours'
                  group by snapshot_ts, instance_pk
                ) per_sample
                where not exists (
                  select 1 from agg.pg_replication_hourly h
                  where h.hour_ts = date_trunc('hour', per_sample.snapshot_ts)
                    and h.instance_pk = per_sample.instance_pk)
                group by 1, 2
                on conflict (hour_ts, instance_pk) do nothing
                """);
            if (n > 0) log.info("Replication hourly rollup: {} satır", n);
        } catch (Exception e) {
            log.warn("Replication hourly rollup hatası: {}", e.getMessage());
        }

        // === SLRU hourly rollup (per name, kümülatif sayaçlardan delta) ===
        try {
            int n = jdbc.update("""
                insert into agg.pg_slru_hourly
                  (hour_ts, instance_pk, name, sample_count, blks_hit_delta,
                   blks_read_delta, blks_written_delta, flushes_delta)
                select date_trunc('hour', sample_ts), instance_pk, name,
                       count(*)::int,
                       greatest(max(blks_hit) - min(blks_hit), 0)::bigint,
                       greatest(max(blks_read) - min(blks_read), 0)::bigint,
                       greatest(max(blks_written) - min(blks_written), 0)::bigint,
                       greatest(max(flushes) - min(flushes), 0)::bigint
                from fact.pg_slru_snapshot
                where sample_ts < now() - interval '1 hour'
                  and sample_ts >= now() - interval '26 hours'
                  and not exists (
                    select 1 from agg.pg_slru_hourly h
                    where h.hour_ts = date_trunc('hour', fact.pg_slru_snapshot.sample_ts)
                      and h.instance_pk = fact.pg_slru_snapshot.instance_pk
                      and h.name = fact.pg_slru_snapshot.name)
                group by 1, 2, 3
                on conflict (hour_ts, instance_pk, name) do nothing
                """);
            if (n > 0) log.info("SLRU hourly rollup: {} satır", n);
        } catch (Exception e) {
            log.warn("SLRU hourly rollup hatası: {}", e.getMessage());
        }

        // === WAL daily rollup (hourly → daily, 365 gün) ===
        try {
            int n = jdbc.update("""
                insert into agg.pg_wal_daily (day_ts, instance_pk, sample_count,
                    wal_bytes_total, wal_directory_size_avg, wal_file_count_avg)
                select date_trunc('day', hour_ts), instance_pk,
                       sum(sample_count)::int,
                       sum(wal_bytes_total)::bigint,
                       avg(wal_directory_size_avg)::bigint,
                       avg(wal_file_count_avg)::int
                from agg.pg_wal_hourly
                where hour_ts < date_trunc('day', now())
                  and hour_ts >= date_trunc('day', now() - interval '3 days')
                  and not exists (
                    select 1 from agg.pg_wal_daily d
                    where d.day_ts = date_trunc('day', agg.pg_wal_hourly.hour_ts)
                      and d.instance_pk = agg.pg_wal_hourly.instance_pk)
                group by 1, 2
                on conflict (day_ts, instance_pk) do nothing
                """);
            if (n > 0) log.info("WAL daily rollup: {} satır", n);

            // Daily retention
            int retDailyDays = 365;
            try {
                Integer cfg = jdbc.queryForObject(
                    "select max(daily_snapshot_retention_days) from control.retention_policy where is_active",
                    Integer.class);
                if (cfg != null && cfg > 0) retDailyDays = cfg;
            } catch (Exception ignore) {}
            int purged = jdbc.update(
                "delete from agg.pg_wal_daily where day_ts < now() - make_interval(days => ?)", retDailyDays);
            if (purged > 0) log.info("Eski WAL daily temizlendi: {} satır", purged);
        } catch (Exception e) {
            log.warn("WAL daily rollup hatası: {}", e.getMessage());
        }

        // === Eski hourly rollup'ları temizle (hourly_snapshot_retention_days) ===
        try {
            int retDays = 90;
            try {
                Integer cfg = jdbc.queryForObject(
                    "select max(hourly_snapshot_retention_days) from control.retention_policy where is_active",
                    Integer.class);
                if (cfg != null && cfg > 0) retDays = cfg;
            } catch (Exception ignore) {}

            int n1 = jdbc.update("delete from agg.pg_wal_hourly where hour_ts < now() - make_interval(days => ?)", retDays);
            int n2 = jdbc.update("delete from agg.pg_archiver_hourly where hour_ts < now() - make_interval(days => ?)", retDays);
            int n3 = jdbc.update("delete from agg.pg_activity_hourly where hour_ts < now() - make_interval(days => ?)", retDays);
            int n4 = jdbc.update("delete from agg.pg_lock_hourly where hour_ts < now() - make_interval(days => ?)", retDays);
            int n5 = jdbc.update("delete from agg.pg_replication_hourly where hour_ts < now() - make_interval(days => ?)", retDays);
            int n6 = jdbc.update("delete from agg.pg_slru_hourly where hour_ts < now() - make_interval(days => ?)", retDays);
            int total = n1 + n2 + n3 + n4 + n5 + n6;
            if (total > 0) log.info("Eski hourly rollup temizlendi: wal={}, archiver={}, activity={}, lock={}, replication={}, slru={} (>{} gün)",
                n1, n2, n3, n4, n5, n6, retDays);
        } catch (Exception e) {
            log.debug("Hourly rollup retention atlandı: {}", e.getMessage());
        }
    }
}
