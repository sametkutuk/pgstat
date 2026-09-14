-- =============================================================================
-- V119 — pg_stat_statements kesif kaniti
--
-- pgss extension surumu PostgreSQL surumunden bagimsizdir. Collector bu surumu
-- sorgu projection'i secmek icin kullaniyor, fakat merkezi sistem hangi surumun
-- ve hangi katalog revision'inin kullanildigini bugune kadar aciklayamiyordu.
--
-- Bu migration mevcut admin_dbname kesfini kanitlar. Veritabanlari arasi tarama
-- ayri bir degisikliktir; pgss_collection_dbname simdilik extension nesnelerinin
-- gercekten cozuldugu admin DB'yi tasir.
-- Durum sozlugu yedi degeri bastan sabitler. Bu dilim available,
-- version_unknown, not_installed, permission_denied ve collection_failed
-- uretiyor; unsupported ile version_incompatible sonraki uyumluluk dilimlerine
-- ayrildi.
-- =============================================================================

alter table control.instance_capability
  add column if not exists pgss_status text,
  add column if not exists pgss_extversion text,
  add column if not exists pgss_collection_dbname text,
  add column if not exists pgss_preloaded boolean,
  add column if not exists pgss_catalog_version integer,
  add column if not exists pgss_checked_at timestamptz;

update control.instance_capability
set pgss_status = case
  when has_pg_stat_statements then 'version_unknown'
  else 'not_installed'
end
where pgss_status is null;

alter table control.instance_capability
  alter column pgss_status set default 'not_installed',
  alter column pgss_status set not null;

alter table control.instance_capability
  add constraint ck_instance_capability_pgss_status check (
    pgss_status in (
      'unsupported',
      'not_installed',
      'permission_denied',
      'version_incompatible',
      'version_unknown',
      'available',
      'collection_failed'
    )
  ),
  add constraint ck_instance_capability_pgss_catalog_version check (
    pgss_catalog_version is null or pgss_catalog_version > 0
  ),
  add constraint ck_instance_capability_pgss_collection_db check (
    pgss_collection_dbname is null or btrim(pgss_collection_dbname) <> ''
  );

create index if not exists ix_instance_capability_pgss_status
  on control.instance_capability (pgss_status, pgss_checked_at);
