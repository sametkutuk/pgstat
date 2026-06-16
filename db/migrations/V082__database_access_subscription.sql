-- =============================================================================
-- V082: database_inaccessible alert konfigurasyonu (per-instance subscription)
-- pgstat bir database'e CONNECT edemediginde (yetki yok) uretilen
-- 'database_inaccessible' alertini kullanici instance bazli yonetebilsin:
--   - is_enabled         : alert tipini ac/kapa
--   - fail_threshold     : kac ardisik basarisiz denemeden sonra alert acilsin
--                          (anlik/gecici hatada hemen alert atmasin)
--   - severity           : alert onem derecesi (warning | critical)
--   - notify_on_inaccessible : alert UI'da gorunsun ama bildirim (Telegram/email)
--                          gitsin mi
-- Ardisik basarisizlik sayaci control.database_state.consecutive_failures'ta
-- zaten per-DB tutuluyor (V002); burada sadece esik saklanir.
-- =============================================================================

create table if not exists control.database_access_subscription (
    subscription_id bigserial primary key,
    instance_pk bigint not null references control.instance_inventory(instance_pk) on delete cascade,
    is_enabled boolean not null default true,
    fail_threshold integer not null default 2 check (fail_threshold >= 1),
    severity text not null default 'warning' check (severity in ('warning', 'critical')),
    notify_on_inaccessible boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (instance_pk)
);

create index if not exists ix_database_access_subscription_enabled
    on control.database_access_subscription (instance_pk)
    where is_enabled = true;

-- Mevcut aktif instance'lar icin varsayilan abonelik (idempotent).
insert into control.database_access_subscription (instance_pk)
select instance_pk
from control.instance_inventory
where is_active = true
on conflict (instance_pk) do nothing;
