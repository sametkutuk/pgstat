-- Smart alert template'leri — esik girmeden aktiflestirilabilir kurallar.
-- alert_category = 'smart', is_enabled = false (kullanici actirmali)

insert into control.alert_rule (
  rule_name, description,
  metric_type, metric_name, scope,
  condition_operator, warning_threshold, critical_threshold,
  evaluation_window_minutes, aggregation,
  evaluation_type, change_threshold_pct, min_data_days,
  alert_category, spike_fallback_pct, flatline_minutes,
  is_enabled, cooldown_minutes, auto_resolve, created_by
)
values

-- -------------------------------------------------------------------------
-- SPIKE: Ani sicramalar (veri az olsa bile spike_fallback_pct ile calisir)
-- -------------------------------------------------------------------------

('Aktif Baglanti Ani Artisi',
 'Son 5 dakikadaki aktif baglanti sayisi, onceki 5 dakikanin 2 katini astiysa uyarir. Yeterli veri yoksa %300 artisi yakalar.',
 'activity_metric', 'active_count', 'all_instances',
 '>', null, null, 5, 'avg',
 'spike', 100.0, 3,
 'smart', 300.0, 0,
 false, 20, true, 'system'),

('Idle-in-Transaction Baglanti Patlamasi',
 'Idle in transaction baglanti sayisi aniden artiyorsa buyuk ihtimalle uzun sureli transaction var.',
 'activity_metric', 'idle_in_transaction_count', 'all_instances',
 '>', null, null, 5, 'avg',
 'spike', 150.0, 3,
 'smart', 400.0, 0,
 false, 15, true, 'system'),

('Call Sayisi Ani Artisi',
 'Sorgu call sayisi aniden artiyorsa trafik patlamasi veya loop sorgusuna isaret edebilir.',
 'statement_metric', 'calls', 'all_instances',
 '>', null, null, 5, 'sum',
 'spike', 200.0, 3,
 'smart', 500.0, 0,
 false, 10, true, 'system'),

('WAL Ani Artisi',
 'WAL uretimi 5 dakikada aniden artiyorsa buyuk bulk write veya DDL islemine isaret eder.',
 'cluster_metric', 'wal_bytes', 'all_instances',
 '>', null, null, 5, 'sum',
 'spike', 200.0, 3,
 'smart', 400.0, 0,
 false, 15, true, 'system'),

-- -------------------------------------------------------------------------
-- FLATLINE: Counter durdu / olcum gelmiyor
-- -------------------------------------------------------------------------

('Replikasyon Durdu',
 'Replica''nin replay_lag_bytes N dakika boyunca hic degismiyorsa replikasyon durmus demektir.',
 'replication_metric', 'replay_lag_bytes', 'all_instances',
 '>', null, null, 5, 'max',
 'flatline', null, 1,
 'smart', null, 10,
 false, 30, false, 'system'),

('Autovacuum Durdu',
 'Belirli bir instance''ta autovacuum_count uzun sure artmiyorsa autovacuum calismiyordur.',
 'database_metric', 'autovacuum_count', 'all_instances',
 '>', null, null, 60, 'sum',
 'flatline', null, 2,
 'smart', null, 120,
 false, 60, false, 'system'),

('Checkpoint Durdu',
 'Checkpoint sayaci uzun sure artmiyorsa bg_writer/checkpointer durmus olabilir.',
 'cluster_metric', 'checkpoints_timed', 'all_instances',
 '>', null, null, 30, 'sum',
 'flatline', null, 1,
 'smart', null, 30,
 false, 60, false, 'system'),

-- -------------------------------------------------------------------------
-- HOURLY_PATTERN: Bu saatin gecmis 4 haftalik ortalamasindan sapma
-- -------------------------------------------------------------------------

('Call Sayisi Saatlik Anomali',
 'Sorgu call sayisi bu saatin gecmis 4 haftalik ortalamasinin cok disina ciktiysa uyarir.',
 'statement_metric', 'calls', 'all_instances',
 '>', null, null, 60, 'sum',
 'hourly_pattern', 80.0, 7,
 'smart', 300.0, 0,
 false, 30, true, 'system'),

('Aktif Baglanti Saatlik Anomali',
 'Aktif baglanti sayisi bu saatin tipik ortalamasinin cok ustundeyse uyarir.',
 'activity_metric', 'active_count', 'all_instances',
 '>', null, null, 60, 'avg',
 'hourly_pattern', 100.0, 7,
 'smart', 300.0, 0,
 false, 20, true, 'system'),

-- -------------------------------------------------------------------------
-- DAY_OVER_DAY / WEEK_OVER_WEEK — smart kategori
-- -------------------------------------------------------------------------

('Call Sayisi Gunluk Degisim',
 'Dunku ayni saate gore call sayisi %10''dan fazla degistiyse uyarir. Trafik anomalilerini erken yakalar.',
 'statement_metric', 'calls', 'all_instances',
 '>', null, null, 60, 'sum',
 'day_over_day', 10.0, 3,
 'smart', null, 0,
 false, 60, true, 'system'),

('Ortalama Sorgu Suresi Gunluk Degisim',
 'Dunku ayni saate gore ortalama sorgu suresi %20''den fazla artmissa sorgu regresyonu olabilir.',
 'statement_metric', 'avg_exec_time_ms', 'all_instances',
 '>', null, null, 60, 'avg',
 'day_over_day', 20.0, 3,
 'smart', null, 0,
 false, 60, true, 'system'),

('Deadlock Gunluk Degisim',
 'Deadlock sayisi dun ayni saate gore %50 arttiysa ciddi contention sorunu var demektir.',
 'database_metric', 'deadlocks', 'all_instances',
 '>', null, null, 60, 'sum',
 'day_over_day', 50.0, 3,
 'smart', null, 0,
 false, 120, true, 'system'),

('Veritabani Boyutu Haftalik Buyume',
 'Veritabani boyutu gecen haftaya gore %10''dan fazla buyuduyse kapasite planlamasi gerekebilir.',
 'database_metric', 'db_size_bytes', 'all_instances',
 '>', null, null, 60, 'max',
 'week_over_week', 10.0, 14,
 'smart', null, 0,
 false, 1440, false, 'system'),

('Tablo Sisme Haftalik Degisim',
 'Dead tuple orani gecen haftaya gore %30 arttiysa autovacuum yetisemiyor demektir.',
 'table_metric', 'dead_tuple_ratio', 'all_instances',
 '>', null, null, 60, 'avg',
 'week_over_week', 30.0, 14,
 'smart', null, 0,
 false, 1440, true, 'system')

on conflict (rule_name, metric_type, metric_name) do nothing;
