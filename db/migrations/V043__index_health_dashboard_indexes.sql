-- =============================================================================
-- V043: Index Health dashboard query support
--
-- Grafana Index Health panelleri son relation size snapshot'ini
-- (instance_pk, dbid, schema, relation, relkind) anahtariyla ariyor.
-- Onceki indeks total_size siralamasi icindi; bu sorgular icin Postgres genis
-- snapshot partition'larini tarayip statement_timeout'a takilabiliyordu.
-- =============================================================================

create index if not exists ix_pg_relation_size_lookup_latest
  on fact.pg_relation_size_snapshot (
    instance_pk,
    dbid,
    schemaname,
    relname,
    relkind,
    snapshot_ts desc
  );

create index if not exists ix_pg_index_stat_usage_30d
  on fact.pg_index_stat_delta (
    instance_pk,
    dbid,
    schemaname,
    index_relname,
    table_relname,
    sample_ts desc
  );
