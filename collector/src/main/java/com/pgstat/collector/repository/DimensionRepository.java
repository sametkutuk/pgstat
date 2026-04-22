package com.pgstat.collector.repository;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * dim sema tablolari icin upsert islemleri.
 * database_ref, relation_ref, role_ref, query_text, statement_series.
 * Mimari dok: satir 3110-3320
 */
@Repository
public class DimensionRepository {

    private final JdbcTemplate jdbc;

    public DimensionRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    // -------------------------------------------------------------------------
    // database_ref
    // -------------------------------------------------------------------------

    /** Database referansi olusturur veya gunceller. */
    public void upsertDatabaseRef(long instancePk, long dbid, String datname,
                                  Boolean isTemplate) {
        jdbc.update("""
            insert into dim.database_ref (instance_pk, dbid, datname, is_template)
            values (?, ?, ?, ?)
            on conflict (instance_pk, dbid) do update
            set datname      = excluded.datname,
                last_seen_at = now()
            """,
            instancePk, dbid, datname, isTemplate
        );
    }

    // -------------------------------------------------------------------------
    // relation_ref
    // -------------------------------------------------------------------------

    /** Tablo/index referansi olusturur veya gunceller. */
    public void upsertRelationRef(long instancePk, long dbid, long relid,
                                  String schemaname, String relname, String relkind) {
        jdbc.update("""
            insert into dim.relation_ref (instance_pk, dbid, relid, schemaname, relname, relkind)
            values (?, ?, ?, ?, ?, ?)
            on conflict (instance_pk, dbid, relid) do update
            set schemaname   = excluded.schemaname,
                relname      = excluded.relname,
                last_seen_at = now()
            """,
            instancePk, dbid, relid, schemaname, relname, relkind
        );
    }

    // -------------------------------------------------------------------------
    // role_ref
    // -------------------------------------------------------------------------

    /** Rol referansi olusturur veya gunceller. */
    public void upsertRoleRef(long instancePk, long userid, String rolname) {
        jdbc.update("""
            insert into dim.role_ref (instance_pk, userid, rolname)
            values (?, ?, ?)
            on conflict (instance_pk, userid) do update
            set rolname      = excluded.rolname,
                last_seen_at = now()
            """,
            instancePk, userid, rolname
        );
    }

    // -------------------------------------------------------------------------
    // query_text
    // -------------------------------------------------------------------------

    /**
     * SQL metni olusturur veya last_seen_at gunceller.
     * @param queryHash SHA-256 hash (32 byte, bytea kolonu icin)
     * @return query_text_id
     */
    public long upsertQueryText(byte[] queryHash, String queryText,
                                Long firstSeenInstancePk, Integer sourcePgMajor) {
        return jdbc.queryForObject("""
            insert into dim.query_text (
              query_hash,
              query_text,
              first_seen_instance_pk,
              source_pg_major
            )
            values (?, ?, ?, ?)
            on conflict (query_hash) do update
            set last_seen_at = now()
            returning query_text_id
            """,
            Long.class,
            queryHash, queryText, firstSeenInstancePk, sourcePgMajor
        );
    }

    // -------------------------------------------------------------------------
    // statement_series
    // -------------------------------------------------------------------------

    /**
     * Statement serisi olusturur veya gunceller.
     * Unique constraint: (instance_pk, system_identifier, pg_major, pgss_epoch_key,
     *                      dbid, userid, coalesce(toplevel::text, 'unknown'), queryid)
     * @return statement_series_id
     */
    public long upsertStatementSeries(long instancePk, int pgMajor,
                                      String collectorSqlFamily, long systemIdentifier,
                                      String pgssEpochKey, long dbid, long userid,
                                      Boolean toplevel, long queryid, Long queryTextId) {
        return jdbc.queryForObject("""
            insert into dim.statement_series (
              instance_pk,
              pg_major,
              collector_sql_family,
              system_identifier,
              pgss_epoch_key,
              dbid,
              userid,
              toplevel,
              queryid,
              query_text_id
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict (
              instance_pk,
              system_identifier,
              pg_major,
              pgss_epoch_key,
              dbid,
              userid,
              (coalesce(toplevel::text, 'unknown')),
              queryid
            )
            do update
            set query_text_id = coalesce(dim.statement_series.query_text_id, excluded.query_text_id),
                last_seen_at = now()
            returning statement_series_id
            """,
            Long.class,
            instancePk, pgMajor, collectorSqlFamily, systemIdentifier,
            pgssEpochKey, dbid, userid, toplevel, queryid, queryTextId
        );
    }

    /**
     * query_text_id'si NULL olan statement_series satirlarini getirir.
     * Text enrichment icin kullanilir.
     * @return statement_series_id ve queryid ciftleri
     */
    public java.util.List<long[]> findSeriesWithoutQueryText(long instancePk, int limit) {
        return jdbc.query("""
            select statement_series_id, queryid
            from dim.statement_series
            where instance_pk = ?
              and query_text_id is null
            order by statement_series_id
            limit ?
            """,
            (rs, rowNum) -> new long[]{
                rs.getLong("statement_series_id"),
                rs.getLong("queryid")
            },
            instancePk, limit
        );
    }

    /** statement_series'e query_text_id baglar (enrichment sonrasi). */
    public void updateSeriesQueryTextId(long statementSeriesId, long queryTextId) {
        jdbc.update("""
            update dim.statement_series
            set query_text_id = ?
            where statement_series_id = ?
            """,
            queryTextId, statementSeriesId
        );
    }
}
