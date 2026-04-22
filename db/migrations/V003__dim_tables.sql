-- =============================================================================
-- V003: Dimension tabloları
-- query_text, database_ref, relation_ref, role_ref, statement_series
-- + index'ler
-- =============================================================================

-- SQL metin deposu: query_hash üzerinden global dedup
create table if not exists dim.query_text (
  query_text_id bigint generated always as identity primary key,
  query_hash bytea not null,
  query_text text not null,
  query_text_len integer generated always as (length(query_text)) stored,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  first_seen_instance_pk bigint null references control.instance_inventory(instance_pk) on delete set null,
  source_pg_major integer null,
  constraint uq_query_text_hash unique (query_hash),
  constraint ck_query_text_hash_len check (octet_length(query_hash) = 32)
);

-- Database referans tablosu: instance bazında database eşleştirmesi
create table if not exists dim.database_ref (
  database_ref_id bigint generated always as identity primary key,
  instance_pk bigint not null references control.instance_inventory(instance_pk) on delete restrict,
  dbid oid not null,
  datname text not null,
  is_template boolean null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint uq_database_ref unique (instance_pk, dbid)
);

-- Tablo/index referans tablosu: OID bazlı
create table if not exists dim.relation_ref (
  relation_ref_id bigint generated always as identity primary key,
  instance_pk bigint not null references control.instance_inventory(instance_pk) on delete restrict,
  dbid oid not null,
  relid oid not null,
  schemaname text not null,
  relname text not null,
  relkind text not null,
  parent_relid oid null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint uq_relation_ref unique (instance_pk, dbid, relid)
);

-- Rol referans tablosu: userid bazlı
create table if not exists dim.role_ref (
  role_ref_id bigint generated always as identity primary key,
  instance_pk bigint not null references control.instance_inventory(instance_pk) on delete restrict,
  userid oid not null,
  rolname text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint uq_role_ref unique (instance_pk, userid)
);

-- Statement serisi: her benzersiz (instance, epoch, db, user, query) kombinasyonu
create table if not exists dim.statement_series (
  statement_series_id bigint generated always as identity primary key,
  instance_pk bigint not null,
  pg_major integer not null,
  collector_sql_family text not null,
  system_identifier bigint not null,
  pgss_epoch_key text not null,
  dbid oid not null,
  userid oid not null,
  toplevel boolean null,
  queryid bigint not null,
  query_text_id bigint null references dim.query_text(query_text_id),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

-- Statement series doğal unique index (coalesce ile NULL toplevel desteği)
create unique index if not exists uq_statement_series_natural
  on dim.statement_series (
    instance_pk,
    system_identifier,
    pg_major,
    pgss_epoch_key,
    dbid,
    userid,
    coalesce(toplevel::text, 'unknown'),
    queryid
  );

-- Dim tabloları index'leri
create index if not exists ix_query_text_last_seen
  on dim.query_text (last_seen_at desc);

create index if not exists ix_database_ref_instance_datname
  on dim.database_ref (instance_pk, datname);

create index if not exists ix_database_ref_last_seen
  on dim.database_ref (last_seen_at desc);

create index if not exists ix_relation_ref_instance_name
  on dim.relation_ref (instance_pk, dbid, schemaname, relname);

create index if not exists ix_relation_ref_last_seen
  on dim.relation_ref (last_seen_at desc);

create index if not exists ix_role_ref_instance_rolname
  on dim.role_ref (instance_pk, rolname);

create index if not exists ix_role_ref_last_seen
  on dim.role_ref (last_seen_at desc);

create index if not exists ix_statement_series_instance_query_text
  on dim.statement_series (instance_pk, query_text_id);

create index if not exists ix_statement_series_instance_ids
  on dim.statement_series (instance_pk, dbid, userid);

create index if not exists ix_statement_series_last_seen
  on dim.statement_series (last_seen_at desc);
