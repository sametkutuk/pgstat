-- =========================================================================
-- V045: Rapor konfigurasyonu + tarihce + notification_log retention
-- =========================================================================
-- Amac:
--   1. Gunluk/haftalik rapor on-off ve saat ayari (kullanici UI'dan duzenler)
--   2. Gonderilen raporlarin DB'de tutulmasi (history)
--   3. Eski raporlarin ve eski notification_log kayitlarinin otomatik temizlenmesi
--      (retention gun bazinda kullanici tarafindan ayarlanir)
-- =========================================================================

-- Singleton config tablosu (config_id = 1, tek satir)
create table if not exists control.report_config (
    config_id                       smallint primary key default 1
                                        check (config_id = 1),
    daily_enabled                   boolean  not null default true,
    daily_hour_utc                  smallint not null default 6
                                        check (daily_hour_utc between 0 and 23),
    daily_retention_days            smallint not null default 30
                                        check (daily_retention_days between 1 and 3650),
    weekly_enabled                  boolean  not null default true,
    weekly_hour_utc                 smallint not null default 6
                                        check (weekly_hour_utc between 0 and 23),
    weekly_retention_days           smallint not null default 90
                                        check (weekly_retention_days between 1 and 3650),
    notification_log_retention_days smallint not null default 14
                                        check (notification_log_retention_days between 1 and 3650),
    updated_at                      timestamptz not null default now()
);

-- Initial seed
insert into control.report_config (config_id) values (1)
on conflict (config_id) do nothing;

-- Updated_at trigger
drop trigger if exists trg_report_config_updated_at on control.report_config;
create trigger trg_report_config_updated_at
    before update on control.report_config
    for each row execute function control.set_updated_at();

-- =========================================================================
-- Rapor tarihcesi
-- =========================================================================
create table if not exists ops.report_history (
    report_id        bigserial primary key,
    report_type      varchar(20) not null
                         check (report_type in ('daily', 'weekly')),
    generated_at     timestamptz not null default now(),
    title            text not null,
    body             text not null,
    recipients_json  jsonb,           -- gonderilen kanal listesi (id, type)
    sent_status      varchar(20) not null default 'sent'
                         check (sent_status in ('sent', 'failed', 'partial')),
    channels_count   smallint not null default 0,
    error_message    text
);

create index if not exists ix_report_history_type_at
    on ops.report_history (report_type, generated_at desc);
create index if not exists ix_report_history_at
    on ops.report_history (generated_at desc);
