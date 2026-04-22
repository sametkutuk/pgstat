-- =============================================================================
-- V009: instance_inventory tablosuna collector_username kolonu ekleme
-- Kaynak PG'ye bağlanırken kullanılacak kullanıcı adı
-- =============================================================================

alter table control.instance_inventory
  add column if not exists collector_username text not null default 'pgstats_collector';

comment on column control.instance_inventory.collector_username
  is 'Kaynak PostgreSQL''e bağlanırken kullanılacak kullanıcı adı';
