package com.pgstat.collector.repository;

import com.pgstat.collector.model.InstanceCapability;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * instance_capability upsert ve sorgulari.
 * Discovery adimindan sonra kabiliyetler buraya yazilir.
 * Mimari dok: satir 3066-3098
 */
@Repository
public class CapabilityRepository {

    private final JdbcTemplate jdbc;

    public CapabilityRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Discovery sonucunu yazar veya gunceller.
     * ON CONFLICT ile idempotent — ayni instance_pk icin tekrar calistirilabilir.
     */
    public void upsert(InstanceCapability cap) {
        jdbc.update("""
            insert into control.instance_capability (
              instance_pk,
              server_version_num,
              pg_major,
              system_identifier,
              collector_sql_family,
              is_reachable,
              is_primary,
              has_pg_stat_statements,
              has_pg_stat_statements_info,
              has_pg_stat_io,
              has_pg_stat_checkpointer,
              compute_query_id_mode,
              last_discovered_at
            )
            values (?, ?, ?, ?, ?, true, ?, ?, ?, ?, ?, ?, now())
            on conflict (instance_pk) do update
            set server_version_num          = excluded.server_version_num,
                pg_major                    = excluded.pg_major,
                system_identifier           = excluded.system_identifier,
                collector_sql_family        = excluded.collector_sql_family,
                is_reachable                = true,
                is_primary                  = excluded.is_primary,
                has_pg_stat_statements      = excluded.has_pg_stat_statements,
                has_pg_stat_statements_info = excluded.has_pg_stat_statements_info,
                has_pg_stat_io              = excluded.has_pg_stat_io,
                has_pg_stat_checkpointer    = excluded.has_pg_stat_checkpointer,
                compute_query_id_mode       = excluded.compute_query_id_mode,
                last_discovered_at          = now()
            """,
            cap.instancePk(),
            cap.serverVersionNum(),
            cap.pgMajor(),
            cap.systemIdentifier(),
            cap.collectorSqlFamily(),
            cap.isPrimary(),
            cap.hasPgStatStatements(),
            cap.hasPgStatStatementsInfo(),
            cap.hasPgStatIo(),
            cap.hasPgStatCheckpointer(),
            cap.computeQueryIdMode()
        );
    }

    /** Baglanti hatasi durumunda sadece is_reachable=false isaretler. */
    public void markUnreachable(long instancePk, String errorText) {
        jdbc.update("""
            update control.instance_capability
            set is_reachable   = false,
                last_error_at  = now(),
                last_error_text = ?
            where instance_pk = ?
            """,
            errorText, instancePk
        );
    }

    /** Belirli bir instance'in pg_major degerini okur. */
    public Integer findPgMajor(long instancePk) {
        return jdbc.queryForObject("""
            select pg_major
            from control.instance_capability
            where instance_pk = ?
            """,
            Integer.class,
            instancePk
        );
    }

    /** Belirli bir instance'in collector_sql_family degerini okur. */
    public String findSqlFamily(long instancePk) {
        return jdbc.queryForObject("""
            select collector_sql_family
            from control.instance_capability
            where instance_pk = ?
            """,
            String.class,
            instancePk
        );
    }
}
