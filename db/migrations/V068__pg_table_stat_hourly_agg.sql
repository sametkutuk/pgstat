-- V068: pg_table_stat_delta icin saatlik aggregate

create schema if not exists agg;

create table if not exists agg.pg_table_stat_hourly (
    bucket_start timestamptz not null,
    instance_pk bigint not null,
    dbid oid not null,
    relid oid not null,
    schemaname text not null,
    relname text not null,

    -- Delta sum: bucket icindeki toplam aktivite
    n_tup_ins_sum bigint,
    n_tup_upd_sum bigint,
    n_tup_del_sum bigint,
    n_tup_hot_upd_sum bigint,
    vacuum_count_sum bigint,
    autovacuum_count_sum bigint,
    analyze_count_sum bigint,
    autoanalyze_count_sum bigint,
    seq_scan_sum bigint,
    idx_scan_sum bigint,

    -- Snapshot: bucket sonundaki son sample degeri
    n_live_tup_last bigint,
    n_dead_tup_last bigint,
    n_mod_since_analyze_last bigint,
    last_vacuum timestamptz,
    last_autovacuum timestamptz,
    last_analyze timestamptz,
    last_autoanalyze timestamptz,

    constraint pg_table_stat_hourly_pkey primary key
        (bucket_start, instance_pk, dbid, relid)
) partition by range (bucket_start);

create index if not exists ix_pg_table_stat_hourly_bucket
    on agg.pg_table_stat_hourly (bucket_start desc);

create index if not exists ix_pg_table_stat_hourly_instance_rel_bucket
    on agg.pg_table_stat_hourly (instance_pk, dbid, relid, bucket_start desc);

comment on table agg.pg_table_stat_hourly is
    'pg_stat_user_tables saatlik rollup (fact.pg_table_stat_delta uzerinden). Delta sumlari + snapshot son degeri. Hourly retention politikasi uygulanir.';
