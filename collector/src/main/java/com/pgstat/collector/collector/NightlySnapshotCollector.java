package com.pgstat.collector.collector;

import com.pgstat.collector.model.InstanceInfo;
import com.pgstat.collector.service.SourceConnectionFactory;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.sql.*;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;

/**
 * Gece PG parametre/catalog snapshot collector.
 * UTC 03:00'te JobOrchestrator tarafindan tetiklenir.
 *
 * Her ready instance icin:
 * 1. pg_settings (secili parametreler)
 * 2. pg_relation_size (tablo/index boyutlari — per-DB)
 * 3. pg_sequences (sequence doluluk — per-DB)
 * 4. pg_database freeze age (xid wraparound riski)
 *
 * Per-DB sorgular icin her aktif DB'ye ayri baglanti acilir.
 * PG surum uyumlulugu: pg_sequences PG10+, diger sorgular PG9.4+.
 */
@Component
public class NightlySnapshotCollector {

    private static final Logger log = LoggerFactory.getLogger(NightlySnapshotCollector.class);

    private final JdbcTemplate jdbc;
    private final SourceConnectionFactory connFactory;

    // Toplanacak pg_settings anahtarlari
    private static final String SETTINGS_QUERY = """
        select name, setting, unit, context, source from pg_settings
        where name in (
          'work_mem', 'maintenance_work_mem', 'shared_buffers',
          'effective_cache_size', 'wal_buffers',
          'checkpoint_timeout', 'checkpoint_completion_target',
          'max_wal_size', 'min_wal_size', 'wal_compression',
          'autovacuum_vacuum_scale_factor', 'autovacuum_analyze_scale_factor',
          'autovacuum_vacuum_threshold', 'autovacuum_max_workers',
          'autovacuum_freeze_max_age', 'autovacuum_naptime',
          'jit', 'jit_above_cost', 'jit_inline_above_cost',
          'max_connections', 'random_page_cost', 'seq_page_cost',
          'log_min_duration_statement', 'log_temp_files',
          'hot_standby_feedback', 'max_standby_streaming_delay',
          'fsync', 'synchronous_commit', 'full_page_writes'
        )
        """;

    // Tablo/index boyutlari — sadece user schema, > 1MB
    private static final String RELATION_SIZE_QUERY = """
        select
          n.nspname as schemaname,
          c.relname,
          c.relkind::text,
          pg_total_relation_size(c.oid) as total_size_bytes,
          case when c.relkind in ('r','m') then pg_relation_size(c.oid) else null end as table_size_bytes,
          case when c.relkind in ('r','m') then
            coalesce((select sum(pg_relation_size(i.indexrelid))
                      from pg_index i where i.indrelid = c.oid), 0)
            else null end as index_size_bytes,
          case when c.relkind in ('r','m') and c.reltoastrelid > 0 then
            pg_total_relation_size(c.reltoastrelid) else null end as toast_size_bytes
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'i', 'm')
          and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
          and not n.nspname like 'pg_temp_%'
          and pg_total_relation_size(c.oid) > 1048576
        """;

    // Sequence durumlari (PG10+)
    private static final String SEQUENCE_QUERY = """
        select
          schemaname, sequencename as seqname, data_type::text,
          last_value as current_value, max_value,
          case when max_value > 0 then
            round((coalesce(last_value, 0)::numeric / max_value::numeric) * 100, 2)
            else null end as used_pct
        from pg_sequences
        where schemaname not in ('pg_catalog', 'information_schema')
        """;

    // Database freeze age
    private static final String FREEZE_QUERY = """
        select datname, oid as dbid,
               age(datfrozenxid) as datfrozenxid_age,
               mxid_age(datminmxid) as datminmxid_age
        from pg_database
        where datallowconn and not datistemplate
        """;

    // Sıcak (hot) refresh için sadece alert hesabında kullanılan kritik 11 parametre.
    // 3 saatte bir yenilenir → ALTER SYSTEM sonrası alert eski değer görmesin.
    private static final String HOT_SETTINGS_QUERY = """
        select name, setting, unit, context, source from pg_settings
        where name in (
          'work_mem', 'maintenance_work_mem', 'shared_buffers',
          'effective_cache_size', 'max_connections',
          'max_wal_size', 'checkpoint_timeout', 'checkpoint_completion_target',
          'autovacuum_vacuum_scale_factor', 'autovacuum_max_workers',
          'random_page_cost'
        )
        """;

    public NightlySnapshotCollector(JdbcTemplate jdbc, SourceConnectionFactory connFactory) {
        this.jdbc = jdbc;
        this.connFactory = connFactory;
    }

    /**
     * Sadece kritik 11 parametreyi yeniler — 3 saatte bir veya manuel tetiklemeyle.
     * Tüm nightly snapshot yerine hızlı + düşük yük yol.
     */
    public long collectHotSettings(InstanceInfo instance) {
        long instancePk = instance.instancePk();
        OffsetDateTime now = OffsetDateTime.now(java.time.ZoneOffset.UTC);
        try (Connection conn = connFactory.connect(instance)) {
            long rows = 0;
            try (Statement stmt = conn.createStatement();
                 ResultSet rs = stmt.executeQuery(HOT_SETTINGS_QUERY)) {
                while (rs.next()) {
                    jdbc.update(
                        "insert into fact.pg_settings_snapshot (snapshot_ts, instance_pk, setting_name, setting_value, unit, context, source) " +
                        "values (?, ?, ?, ?, ?, ?, ?) on conflict do nothing",
                        now, instancePk, rs.getString("name"), rs.getString("setting"),
                        rs.getString("unit"), rs.getString("context"), rs.getString("source"));
                    rows++;
                }
            }
            log.debug("Hot settings refresh {}: {} parametre", instance.instanceId(), rows);
            return rows;
        } catch (Exception e) {
            log.warn("Hot settings refresh hatası {}: {}", instance.instanceId(), e.getMessage());
            return 0;
        }
    }

    /**
     * Tek instance icin tum gece snapshot'larini toplar.
     * Admin DB'ye baglanir (settings + freeze), sonra her aktif DB'ye (relation size + sequences).
     */
    public long collectAll(InstanceInfo instance) {
        long instancePk = instance.instancePk();
        OffsetDateTime now = OffsetDateTime.now(java.time.ZoneOffset.UTC);
        long totalRows = 0;

        try (Connection adminConn = connFactory.connect(instance)) {
            // 1. pg_settings — admin DB'den
            totalRows += collectSettings(adminConn, instancePk, now);

            // 2. Database freeze age — admin DB'den
            totalRows += collectFreezeAge(adminConn, instancePk, now);

            // 3. Aktif DB listesini al
            List<String> databases = getActiveDatabases(adminConn);

            // 4. Her DB icin relation size + sequence state
            for (String dbname : databases) {
                try (Connection dbConn = connFactory.connect(instance, dbname)) {
                    long dbid = getDbOid(dbConn, dbname);
                    totalRows += collectRelationSizes(dbConn, instancePk, dbid, now);
                    totalRows += collectSequenceStates(dbConn, instancePk, dbid, now);
                } catch (Exception e) {
                    log.debug("Nightly snapshot DB baglanti hatasi {}/{}: {}",
                        instance.instanceId(), dbname, e.getMessage());
                }
            }
        } catch (Exception e) {
            log.warn("Nightly snapshot hatasi {}: {}", instance.instanceId(), e.getMessage());
            return 0;
        }

        log.info("Nightly snapshot tamamlandi: {} — {} satir", instance.instanceId(), totalRows);
        return totalRows;
    }

    // =========================================================================
    // pg_settings
    // =========================================================================

    private long collectSettings(Connection conn, long instancePk, OffsetDateTime now) throws SQLException {
        List<Object[]> batch = new ArrayList<>();
        try (Statement stmt = conn.createStatement();
             ResultSet rs = stmt.executeQuery(SETTINGS_QUERY)) {
            while (rs.next()) {
                batch.add(new Object[]{
                    now, instancePk,
                    rs.getString("name"),
                    rs.getString("setting"),
                    rs.getString("unit"),
                    rs.getString("context"),
                    rs.getString("source")
                });
            }
        }
        if (batch.isEmpty()) return 0;

        jdbc.batchUpdate(
            "insert into fact.pg_settings_snapshot (snapshot_ts, instance_pk, setting_name, setting_value, unit, context, source) " +
            "values (?, ?, ?, ?, ?, ?, ?) on conflict do nothing",
            batch.stream().map(row -> (Object[]) row).toList()
        );
        return batch.size();
    }

    // =========================================================================
    // Database freeze age
    // =========================================================================

    private long collectFreezeAge(Connection conn, long instancePk, OffsetDateTime now) throws SQLException {
        List<Object[]> batch = new ArrayList<>();
        try (Statement stmt = conn.createStatement();
             ResultSet rs = stmt.executeQuery(FREEZE_QUERY)) {
            while (rs.next()) {
                batch.add(new Object[]{
                    now, instancePk,
                    rs.getLong("dbid"),
                    rs.getString("datname"),
                    rs.getLong("datfrozenxid_age"),
                    rs.getLong("datminmxid_age")
                });
            }
        }
        if (batch.isEmpty()) return 0;

        jdbc.batchUpdate(
            "insert into fact.pg_database_freeze_snapshot (snapshot_ts, instance_pk, dbid, datname, datfrozenxid_age, datminmxid_age) " +
            "values (?, ?, ?, ?, ?, ?) on conflict do nothing",
            batch.stream().map(row -> (Object[]) row).toList()
        );
        return batch.size();
    }

    // =========================================================================
    // Relation sizes (per-DB)
    // =========================================================================

    private long collectRelationSizes(Connection conn, long instancePk, long dbid, OffsetDateTime now) throws SQLException {
        List<Object[]> batch = new ArrayList<>();
        try (Statement stmt = conn.createStatement();
             ResultSet rs = stmt.executeQuery(RELATION_SIZE_QUERY)) {
            while (rs.next()) {
                batch.add(new Object[]{
                    now, instancePk, dbid,
                    rs.getString("schemaname"),
                    rs.getString("relname"),
                    rs.getString("relkind"),
                    rs.getLong("total_size_bytes"),
                    rs.getObject("table_size_bytes") != null ? rs.getLong("table_size_bytes") : null,
                    rs.getObject("index_size_bytes") != null ? rs.getLong("index_size_bytes") : null,
                    rs.getObject("toast_size_bytes") != null ? rs.getLong("toast_size_bytes") : null
                });
            }
        }
        if (batch.isEmpty()) return 0;

        jdbc.batchUpdate(
            "insert into fact.pg_relation_size_snapshot (snapshot_ts, instance_pk, dbid, schemaname, relname, relkind, total_size_bytes, table_size_bytes, index_size_bytes, toast_size_bytes) " +
            "values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing",
            batch.stream().map(row -> (Object[]) row).toList()
        );
        return batch.size();
    }

    // =========================================================================
    // Sequence states (per-DB, PG10+)
    // =========================================================================

    private long collectSequenceStates(Connection conn, long instancePk, long dbid, OffsetDateTime now) throws SQLException {
        List<Object[]> batch = new ArrayList<>();
        try (Statement stmt = conn.createStatement();
             ResultSet rs = stmt.executeQuery(SEQUENCE_QUERY)) {
            while (rs.next()) {
                batch.add(new Object[]{
                    now, instancePk, dbid,
                    rs.getString("schemaname"),
                    rs.getString("seqname"),
                    rs.getString("data_type"),
                    rs.getObject("current_value") != null ? rs.getLong("current_value") : null,
                    rs.getLong("max_value"),
                    rs.getObject("used_pct") != null ? rs.getBigDecimal("used_pct") : null
                });
            }
        } catch (SQLException e) {
            // pg_sequences view PG10+ — eski surumlerde graceful skip
            if (e.getMessage() != null && e.getMessage().contains("pg_sequences")) {
                log.debug("pg_sequences view yok (PG10 oncesi?): {}", e.getMessage());
                return 0;
            }
            throw e;
        }
        if (batch.isEmpty()) return 0;

        jdbc.batchUpdate(
            "insert into fact.pg_sequence_state_snapshot (snapshot_ts, instance_pk, dbid, schemaname, seqname, data_type, current_value, max_value, used_pct) " +
            "values (?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing",
            batch.stream().map(row -> (Object[]) row).toList()
        );
        return batch.size();
    }

    // =========================================================================
    // Yardimci
    // =========================================================================

    /** Aktif (template olmayan, connect izni olan) DB listesi */
    private List<String> getActiveDatabases(Connection conn) throws SQLException {
        List<String> dbs = new ArrayList<>();
        try (Statement stmt = conn.createStatement();
             ResultSet rs = stmt.executeQuery(
                 "select datname from pg_database where datallowconn and not datistemplate order by datname")) {
            while (rs.next()) {
                dbs.add(rs.getString("datname"));
            }
        }
        // Max 10 DB — cok fazla DB varsa snapshot job uzar
        return dbs.size() > 10 ? dbs.subList(0, 10) : dbs;
    }

    /** DB OID'sini al (dbid olarak kullanilir) */
    private long getDbOid(Connection conn, String dbname) throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement(
                "select oid from pg_database where datname = ?")) {
            ps.setString(1, dbname);
            try (ResultSet rs = ps.executeQuery()) {
                return rs.next() ? rs.getLong(1) : 0;
            }
        }
    }
}
