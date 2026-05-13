-- V062: Alert eval penceresi konfigure edilebilir
-- Daha onceden ActionableAlertEvaluator icinde hardcoded olan
-- "interval 'X minutes/hours'" pencereleri artik kuraldan okunur.

alter table control.system_alert_config
    add column if not exists window_minutes integer null;

-- Mevcut alert kodlari icin default window'lari seed et (sadece global = instance_pk is null)
update control.system_alert_config set window_minutes = 15
    where alert_code = 'high_temp_files'           and instance_pk is null and window_minutes is null;
update control.system_alert_config set window_minutes = 60
    where alert_code = 'idle_in_tx_time_high'      and instance_pk is null and window_minutes is null;
update control.system_alert_config set window_minutes = 60
    where alert_code = 'replication_slot_inactive' and instance_pk is null and window_minutes is null;
update control.system_alert_config set window_minutes = 60
    where alert_code = 'high_connection_usage'     and instance_pk is null and window_minutes is null;
update control.system_alert_config set window_minutes = 1440
    where alert_code = 'index_suspect_missing'     and instance_pk is null and window_minutes is null;
update control.system_alert_config set window_minutes = 1440
    where alert_code = 'high_temp_files_daily'     and instance_pk is null and window_minutes is null;
update control.system_alert_config set window_minutes = 1440
    where alert_code = 'high_temp_sqls_daily'      and instance_pk is null and window_minutes is null;
update control.system_alert_config set window_minutes = 10
    where alert_code = 'stale_data'                and instance_pk is null and window_minutes is null;
