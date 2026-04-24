-- Anomali tespit template'leri (day_over_day, week_over_week, alltime_high/low)

insert into control.alert_rule
  (rule_name, description, metric_type, metric_name, scope,
   condition_operator, warning_threshold, critical_threshold,
   evaluation_window_minutes, aggregation, evaluation_type,
   change_threshold_pct, min_data_days,
   is_enabled, cooldown_minutes, auto_resolve, created_by)
values
  -- Günlük trend anomalileri
  ('WAL Üretimi — Günlük Artış',
   'Bugünkü WAL üretimi dünün aynı saatine göre %50''den fazla artmışsa uyarır.',
   'cluster_metric', 'wal_bytes', 'all_instances',
   '>', null, null, 60, 'sum', 'day_over_day', 50, 7,
   false, 60, true, 'system'),

  ('Deadlock — Günlük Artış',
   'Bugünkü deadlock sayısı dünün aynı saatine göre %100 artmışsa kritik.',
   'database_metric', 'deadlocks', 'all_instances',
   '>', null, null, 60, 'sum', 'day_over_day', 100, 3,
   false, 30, true, 'system'),

  ('Aktif Bağlantı — Günlük Artış',
   'Aktif bağlantı sayısı dünden %80 daha fazlaysa uyarır.',
   'activity_metric', 'active_count', 'all_instances',
   '>', null, null, 60, 'avg', 'day_over_day', 80, 3,
   false, 30, true, 'system'),

  ('Ortalama Sorgu Süresi — Günlük Artış',
   'Ortalama sorgu süresi dünün aynı saatine göre %100 artmışsa uyarır.',
   'statement_metric', 'avg_exec_time_ms', 'all_instances',
   '>', null, null, 60, 'avg', 'day_over_day', 100, 7,
   false, 30, true, 'system'),

  -- Haftalık trend anomalileri
  ('WAL Üretimi — Haftalık Artış',
   'Bu haftanın aynı günü geçen haftaya göre %100 daha fazla WAL üretmişse uyarır.',
   'cluster_metric', 'wal_bytes', 'all_instances',
   '>', null, null, 1440, 'sum', 'week_over_week', 100, 14,
   false, 360, true, 'system'),

  ('Deadlock — Haftalık Artış',
   'Bu haftaki deadlock sayısı geçen haftanın aynı gününe göre %200 artmışsa kritik.',
   'database_metric', 'deadlocks', 'all_instances',
   '>', null, null, 1440, 'sum', 'week_over_week', 200, 14,
   false, 360, true, 'system'),

  -- Tüm zamanlar rekorları
  ('Cache Hit Ratio — Tüm Zamanlar En Düşük',
   'Cache hit ratio tüm zamanların en düşük değerine yaklaşırsa uyarır.',
   'cluster_metric', 'cache_hit_ratio', 'all_instances',
   '<', null, null, 60, 'avg', 'alltime_low', null, 14,
   false, 240, false, 'system'),

  ('Aktif Bağlantı — Tüm Zamanlar En Yüksek',
   'Aktif bağlantı sayısı hiç bu kadar yüksek olmamışsa uyarır.',
   'activity_metric', 'active_count', 'all_instances',
   '>', null, null, 5, 'max', 'alltime_high', null, 7,
   false, 60, false, 'system'),

  ('Replay Lag — Tüm Zamanlar En Yüksek',
   'Replikasyon gecikmesi rekor seviyeye ulaşırsa kritik.',
   'replication_metric', 'replay_lag_bytes', 'all_instances',
   '>', null, null, 5, 'max', 'alltime_high', null, 7,
   false, 30, true, 'system')
on conflict (rule_name, metric_type, metric_name) do nothing;
