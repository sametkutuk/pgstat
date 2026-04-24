-- V025: WAL / archiver / slot / conflict metrikleri icin hazir alert templates
-- ============================================================================
-- Tumu is_enabled=false (kullanici aktiflestirir)

insert into control.alert_rule (
  rule_name, description,
  metric_type, metric_name, scope,
  condition_operator, warning_threshold, critical_threshold,
  evaluation_window_minutes, aggregation,
  evaluation_type, change_threshold_pct, min_data_days,
  alert_category, spike_fallback_pct, flatline_minutes,
  is_enabled, cooldown_minutes, auto_resolve, created_by
) values

-- -------------------------------------------------------------------------
-- WAL
-- -------------------------------------------------------------------------

('WAL Directory Buyuk',
 'WAL dizini disk kullanimi yuksek — inactive slot veya archive_command takili olabilir.',
 'wal_metric', 'wal_directory_size_byte', 'all_instances',
 '>', 5368709120, 21474836480, 5, 'max',  -- 5 GB warning, 20 GB critical
 'threshold', null, 0,
 'threshold', null, 0,
 false, 30, true, 'system'),

('WAL Uretimi Ani Artisi',
 'Son 5 dakikada uretilen WAL boyutu onceki 5 dakikayi ikiye katladiysa uyarir.',
 'wal_metric', 'period_wal_size_byte', 'all_instances',
 '>', null, null, 5, 'sum',
 'spike', 100.0, 3,
 'smart', 300.0, 0,
 false, 15, true, 'system'),

('WAL Dosya Sayisi Yuksek',
 'WAL dosya sayisi 1000 uzerinde — archive problemi veya pg_wal temizlenmiyor.',
 'wal_metric', 'wal_file_count', 'all_instances',
 '>', 1000, 5000, 5, 'max',
 'threshold', null, 0,
 'threshold', null, 0,
 false, 30, true, 'system'),

-- -------------------------------------------------------------------------
-- Archiver
-- -------------------------------------------------------------------------

('Archive Hata Sayisi Artiyor',
 'pg_stat_archiver.failed_count artisi var — WAL archive_command hata veriyor.',
 'archiver_metric', 'failed_count', 'all_instances',
 '>', null, null, 10, 'max',
 'spike', 50.0, 3,
 'smart', 100.0, 0,
 false, 10, false, 'system'),

-- -------------------------------------------------------------------------
-- Replication slot
-- -------------------------------------------------------------------------

('Replication Slot Sisme Riski',
 'Bir replication slot''un slot_lag_bytes degeri cok buyuk — WAL birikiyor.',
 'slot_metric', 'slot_lag_bytes', 'all_instances',
 '>', 1073741824, 10737418240, 5, 'max',  -- 1 GB warning, 10 GB critical
 'threshold', null, 0,
 'threshold', null, 0,
 false, 30, true, 'system'),

-- -------------------------------------------------------------------------
-- Standby conflicts
-- -------------------------------------------------------------------------

('Standby Lock Conflict Ani Artisi',
 'pg_stat_database_conflicts.confl_lock son 10 dakikada ani artti.',
 'conflict_metric', 'confl_lock', 'all_instances',
 '>', null, null, 10, 'sum',
 'spike', 50.0, 3,
 'smart', 100.0, 0,
 false, 30, true, 'system'),

('Standby Deadlock Conflict',
 'pg_stat_database_conflicts.confl_deadlock artisi — standby''da deadlock olusuyor.',
 'conflict_metric', 'confl_deadlock', 'all_instances',
 '>', null, null, 10, 'sum',
 'spike', 50.0, 3,
 'smart', 100.0, 0,
 false, 30, true, 'system')

on conflict (rule_name, metric_type, metric_name) do nothing;
