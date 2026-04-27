-- =============================================================================
-- V035: Bootstrap otomatik yeniden deneme (exponential backoff)
--
-- Instance bootstrap basarisiz olursa 'degraded' state'e duser. Onceden
-- manuel "Yeniden Dene" butonu gerekiyordu. Bu migration ile collector
-- otomatik retry yapar:
--   1. deneme: hemen
--   2. deneme: 1 dakika sonra
--   3. deneme: 5 dakika sonra
--   4. deneme: 15 dakika sonra
--   5+ deneme: 1 saat sonra (cap)
-- Manuel "Yeniden Dene" sayaci sifirlar.
-- =============================================================================

alter table control.instance_inventory
  add column if not exists bootstrap_retry_count integer not null default 0,
  add column if not exists next_bootstrap_retry_at timestamptz null;

comment on column control.instance_inventory.bootstrap_retry_count is
  'Bootstrap basarisizlik sayaci. Manuel reset (UI''dan retry) ile sifirlanir.';
comment on column control.instance_inventory.next_bootstrap_retry_at is
  'Bir sonraki otomatik retry zamani. NULL ise hemen denenebilir.';

create index if not exists ix_instance_inventory_next_retry
  on control.instance_inventory (next_bootstrap_retry_at)
  where bootstrap_state = 'degraded';
