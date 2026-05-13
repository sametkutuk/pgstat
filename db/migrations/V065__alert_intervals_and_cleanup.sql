-- V065: Alert sıklık ayarları + event-tipi alert + database cleanup feature
--
-- 3 ana değişiklik:
-- 1) system_alert_config'e is_event_type ve include_in_daily_report kolonları
-- 2) Sıklık ayarları için meta-key satırları
-- 3) Database action log tablosu + database_ref'e is_active kolonu

-- =========================================================================
-- 1) Event-tipi alert flagleri
-- =========================================================================
alter table control.system_alert_config
    add column if not exists is_event_type boolean not null default false;
alter table control.system_alert_config
    add column if not exists include_in_daily_report boolean not null default true;

comment on column control.system_alert_config.is_event_type is
    'Olay tipi alert (job_failed, stats_reset gibi). True ise otomatik kapanmaz, cooldown uzun olur.';
comment on column control.system_alert_config.include_in_daily_report is
    'True ise gunluk raporda "Olay Bildirileri" bolumunde gosterilir.';

-- Event-tipi alert'leri isaretle
update control.system_alert_config
set is_event_type = true,
    cooldown_minutes = greatest(cooldown_minutes, 1440)  -- min 24h
where alert_code in ('job_failed', 'job_partial_failure', 'stats_reset_detected',
                     'bootstrap_failed', 'extension_missing', 'secret_ref_error')
  and instance_pk is null;

-- =========================================================================
-- 2) Siklik ayarlari (acute/frequent/daily) — meta-key satirlari
-- =========================================================================
-- alert_code = '__system_intervals' kullanarak tek satirda 3 deger tutariz.
-- threshold_value     -> acute_interval_seconds  (5..300)
-- cooldown_minutes    -> frequent_interval_seconds (60..3600)
-- window_minutes      -> daily_interval_hours (1..168)
-- Bu kolonlari yeniden kullaniyoruz; cunku bunlar zaten numeric.

insert into control.system_alert_config
    (alert_code, instance_pk, is_enabled, threshold_value, cooldown_minutes, window_minutes,
     is_event_type, include_in_daily_report)
values
    ('__system_intervals', null, true, 5, 900, 24, false, false)
on conflict (alert_code) where instance_pk is null do nothing;

-- =========================================================================
-- 3) Database action log + database_ref'e is_active
-- =========================================================================
alter table dim.database_ref
    add column if not exists is_active boolean not null default true,
    add column if not exists disabled_at timestamptz null,
    add column if not exists disabled_reason text null;

create table if not exists control.database_action_log (
    log_id        bigserial primary key,
    instance_pk   bigint not null,
    dbid          oid null,
    datname       text not null,
    action        text not null check (action in ('disabled', 're_enabled', 'note')),
    reason        text null,
    alert_id      bigint null,
    actioned_by   text not null default 'admin',
    actioned_at   timestamptz not null default now()
);

create index if not exists ix_database_action_log_instance
    on control.database_action_log (instance_pk, actioned_at desc);
create index if not exists ix_database_action_log_alert
    on control.database_action_log (alert_id) where alert_id is not null;
