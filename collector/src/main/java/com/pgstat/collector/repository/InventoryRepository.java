package com.pgstat.collector.repository;

import com.pgstat.collector.model.InstanceInfo;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.time.OffsetDateTime;
import java.util.List;

/**
 * instance_inventory CRUD + scheduler sorgulari.
 * Mimari dok: satir 2910-3063
 */
@Repository
public class InventoryRepository {

    private final JdbcTemplate jdbc;

    public InventoryRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    // -------------------------------------------------------------------------
    // Bootstrap queue — pending/discovering/baselining/enriching instance'lar
    // -------------------------------------------------------------------------

    /** Bootstrap bekleyen instance'lari getirir (FOR UPDATE SKIP LOCKED). */
    public List<InstanceInfo> findBootstrapQueue(int limit) {
        return jdbc.query("""
            select
              i.instance_pk,
              i.instance_id,
              i.host,
              i.port,
              i.admin_dbname,
              i.secret_ref,
              i.ssl_mode,
              i.bootstrap_state,
              i.collector_username,
              p.connect_timeout_seconds,
              p.statement_timeout_ms,
              p.lock_timeout_ms,
              p.bootstrap_sql_text_batch,
              p.cluster_interval_seconds,
              p.statements_interval_seconds
            from control.instance_inventory i
            join control.schedule_profile p on p.schedule_profile_id = i.schedule_profile_id
            where i.is_active
              and i.bootstrap_state in ('pending', 'discovering', 'baselining', 'enriching')
            order by i.instance_pk
            for update of i skip locked
            limit ?
            """,
            (rs, rowNum) -> new InstanceInfo(
                rs.getLong("instance_pk"),
                rs.getString("instance_id"),
                rs.getString("host"),
                rs.getInt("port"),
                rs.getString("admin_dbname"),
                rs.getString("secret_ref"),
                rs.getString("ssl_mode"),
                rs.getString("bootstrap_state"),
                rs.getString("collector_username"),
                rs.getInt("connect_timeout_seconds"),
                rs.getInt("statement_timeout_ms"),
                rs.getInt("lock_timeout_ms"),
                rs.getInt("bootstrap_sql_text_batch"),
                rs.getInt("cluster_interval_seconds"),
                rs.getInt("statements_interval_seconds"),
                null, // nextClusterCollectAt — bootstrap'ta yok
                null  // nextStatementsCollectAt — bootstrap'ta yok
            ),
            limit
        );
    }

    // -------------------------------------------------------------------------
    // Steady-state scheduler — ready/degraded instance'lar
    // -------------------------------------------------------------------------

    /** Toplama zamani gelmis instance'lari getirir (cluster veya statements due). */
    public List<InstanceInfo> findDueInstances(int limit) {
        return jdbc.query("""
            select
              i.instance_pk,
              i.instance_id,
              i.host,
              i.port,
              i.admin_dbname,
              i.secret_ref,
              i.ssl_mode,
              i.bootstrap_state,
              i.collector_username,
              s.next_cluster_collect_at,
              s.next_statements_collect_at,
              p.cluster_interval_seconds,
              p.statements_interval_seconds,
              p.bootstrap_sql_text_batch,
              p.statement_timeout_ms,
              p.lock_timeout_ms,
              p.connect_timeout_seconds
            from control.instance_inventory i
            join control.instance_state s on s.instance_pk = i.instance_pk
            join control.schedule_profile p on p.schedule_profile_id = i.schedule_profile_id
            where i.is_active
              and i.bootstrap_state in ('ready', 'degraded')
              and (s.backoff_until is null or s.backoff_until <= now())
              and (
                coalesce(s.next_cluster_collect_at, '-infinity'::timestamptz) <= now()
                or coalesce(s.next_statements_collect_at, '-infinity'::timestamptz) <= now()
              )
            order by least(
              coalesce(s.next_cluster_collect_at, '-infinity'::timestamptz),
              coalesce(s.next_statements_collect_at, '-infinity'::timestamptz)
            )
            for update of s skip locked
            limit ?
            """,
            (rs, rowNum) -> new InstanceInfo(
                rs.getLong("instance_pk"),
                rs.getString("instance_id"),
                rs.getString("host"),
                rs.getInt("port"),
                rs.getString("admin_dbname"),
                rs.getString("secret_ref"),
                rs.getString("ssl_mode"),
                rs.getString("bootstrap_state"),
                rs.getString("collector_username"),
                rs.getInt("connect_timeout_seconds"),
                rs.getInt("statement_timeout_ms"),
                rs.getInt("lock_timeout_ms"),
                rs.getInt("bootstrap_sql_text_batch"),
                rs.getInt("cluster_interval_seconds"),
                rs.getInt("statements_interval_seconds"),
                rs.getObject("next_cluster_collect_at", OffsetDateTime.class),
                rs.getObject("next_statements_collect_at", OffsetDateTime.class)
            ),
            limit
        );
    }

    // -------------------------------------------------------------------------
    // Bootstrap state guncelleme
    // -------------------------------------------------------------------------

    /** Bootstrap state'ini gunceller (pending → discovering → ... → ready). */
    public void updateBootstrapState(long instancePk, String newState) {
        jdbc.update("""
            update control.instance_inventory
            set bootstrap_state = ?
            where instance_pk = ?
            """,
            newState, instancePk
        );
    }

    // -------------------------------------------------------------------------
    // db_objects scheduler — due database'ler
    // -------------------------------------------------------------------------

    /** Toplama zamani gelmis database'leri getirir (db_objects job icin). */
    public List<com.pgstat.collector.model.DbObjectsTarget> findDueDbObjects(int maxDatabasesPerRun) {
        return jdbc.query("""
            select
              i.instance_pk,
              i.instance_id,
              i.host,
              i.port,
              ds.dbid,
              dr.datname,
              i.secret_ref,
              i.ssl_mode,
              i.collector_username,
              p.db_objects_interval_seconds,
              p.statement_timeout_ms,
              p.lock_timeout_ms,
              p.connect_timeout_seconds
            from control.database_state ds
            join control.instance_inventory i on i.instance_pk = ds.instance_pk
            join control.schedule_profile p on p.schedule_profile_id = i.schedule_profile_id
            join dim.database_ref dr on dr.instance_pk = ds.instance_pk and dr.dbid = ds.dbid
            where i.is_active
              and i.bootstrap_state in ('ready', 'degraded')
              and (ds.backoff_until is null or ds.backoff_until <= now())
              and coalesce(ds.next_db_objects_collect_at, '-infinity'::timestamptz) <= now()
            order by coalesce(ds.next_db_objects_collect_at, '-infinity'::timestamptz)
            limit ?
            """,
            (rs, rowNum) -> new com.pgstat.collector.model.DbObjectsTarget(
                rs.getLong("instance_pk"),
                rs.getString("instance_id"),
                rs.getString("host"),
                rs.getInt("port"),
                rs.getLong("dbid"),
                rs.getString("datname"),
                rs.getString("secret_ref"),
                rs.getString("ssl_mode"),
                rs.getString("collector_username"),
                rs.getInt("db_objects_interval_seconds"),
                rs.getInt("statement_timeout_ms"),
                rs.getInt("lock_timeout_ms"),
                rs.getInt("connect_timeout_seconds")
            ),
            maxDatabasesPerRun
        );
    }
}
