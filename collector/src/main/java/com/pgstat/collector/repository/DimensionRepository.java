package com.pgstat.collector.repository;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Map;

/**
 * dim sema tablolari icin upsert islemleri.
 * database_ref, relation_ref, role_ref, query_text, statement_series.
 * Mimari dok: satir 3110-3320
 */
@Repository
public class DimensionRepository {

    /**
     * last_seen_at tazeleme araligi (PGSTAT-P0-047).
     *
     * Bu damga her toplama dongusunde yaziliyordu. statements_interval 300
     * saniye oldugu icin satir basina GUNDE 288 kez. Olculen sonuc: 92.902
     * ekleme karsiliginda 721.732.172 guncelleme ve %0 HOT — cunku last_seen_at
     * indekslidir ve indeksli kolon degisince HOT devre disi kalir. Tablo 1.76M
     * satir icin 942 MB oldu; olu satir orani %4.6 kaldigi icin ne autovacuum ne
     * de olu-satir alarmi bunu sorun saydi.
     *
     * Damgayi collector HIC OKUMUYOR; okuyan tek yer API arama sonucu
     * siralamasi. Bir saatlik bayatlik orada fark edilmez.
     *
     * DIKKAT: toplama sikligi DEGISMIYOR. Bes dakika, insights.ts icinde alti
     * saatten kisa pencerelerin bes dakikalik adimlarla cizilmesine bagli.
     * Degisen tek sey, ayni damgayi her seferinde yeniden yazmak.
     */
    private static final String LAST_SEEN_REFRESH_INTERVAL = "1 hour";

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
            -- Yalnizca gercekten degisen bir sey varsa yaz (PGSTAT-P0-047).
            -- Ad degistiyse kaydetmek zorundayiz; degismediyse tek yazma sebebi
            -- damgayi tazelemekti ve bunun icin her donguyu beklemeye gerek yok.
            -- Bu metot RETURNING kullanmiyor, bu yuzden WHERE tutmadiginda satir
            -- donmemesi bir sorun degil.
            where dim.relation_ref.schemaname   is distinct from excluded.schemaname
               or dim.relation_ref.relname      is distinct from excluded.relname
               or dim.relation_ref.last_seen_at < now() - ?::interval
            """,
            instancePk, dbid, relid, schemaname, relname, relkind,
            LAST_SEEN_REFRESH_INTERVAL
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

        // ONCE OKU (PGSTAT-P0-047). Bu metot her toplama dongusunde her seri
        // icin cagriliyor ve neredeyse her seferinde seri ZATEN VAR. Eskiden o
        // durumda bile UPDATE atiyorduk: id'yi RETURNING ile alabilmek icin DO
        // UPDATE yazmak zorundayiz, cunku DO NOTHING catismada satir dondurmez.
        // Yani her cagride bir satir kopyalaniyordu; olculen 721 milyon
        // guncellemenin kaynagi bu.
        //
        // DO UPDATE ... WHERE ile filtrelemek cozum DEGIL: kosul tutmadiginda
        // RETURNING satir dondurmez ve queryForObject patlar. Bu yuzden once
        // okuyup yalnizca yazacak bir sey varsa upsert ediyoruz.
        //
        // Predicate, uq_statement_series_natural indeksiyle birebir ayni
        // ifadeleri kullanir; aksi halde indeks kullanilmaz.
        List<Map<String, Object>> existing = jdbc.queryForList("""
            select statement_series_id,
                   query_text_id,
                   last_seen_at < now() - ?::interval as stale
            from dim.statement_series
            where instance_pk       = ?
              and system_identifier = ?
              and pg_major          = ?
              and pgss_epoch_key    = ?
              and dbid              = ?
              and userid            = ?
              and coalesce(toplevel::text, 'unknown') = ?
              and queryid           = ?
            """,
            LAST_SEEN_REFRESH_INTERVAL, instancePk, systemIdentifier, pgMajor,
            pgssEpochKey, dbid, userid,
            toplevel == null ? "unknown" : toplevel.toString(), queryid);

        if (!existing.isEmpty()) {
            Map<String, Object> row = existing.get(0);
            boolean stale = Boolean.TRUE.equals(row.get("stale"));
            // query_text_id yalnizca NULL iken doldurulur (asagidaki coalesce ile
            // ayni kural); doluysa yazacak bir sey yok.
            boolean needsQueryText = row.get("query_text_id") == null && queryTextId != null;
            if (!stale && !needsQueryText) {
                return ((Number) row.get("statement_series_id")).longValue();
            }
        }

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
