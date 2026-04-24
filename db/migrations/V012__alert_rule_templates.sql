-- Hazır alert kuralı template'leri — varsayılan olarak pasif

insert into control.alert_rule
  (rule_name, description, metric_type, metric_name, scope, condition_operator,
   warning_threshold, critical_threshold, evaluation_window_minutes, aggregation,
   is_enabled, cooldown_minutes, auto_resolve, created_by)
values
  -- Cluster Sağlık
  ('Cache Hit Ratio Düşük',
   'Buffer cache etkinliği düştüğünde uyarır. Disk I/O artışını gösterir.',
   'cluster_metric', 'cache_hit_ratio', 'all_instances', '<',
   95, 90, 5, 'avg', false, 15, true, 'system'),

  ('WAL Üretimi Yüksek',
   'Son 5 dakikada üretilen WAL miktarı yüksekse uyarır.',
   'cluster_metric', 'wal_bytes', 'all_instances', '>',
   500000000, 2000000000, 5, 'sum', false, 30, true, 'system'),

  ('Checkpoint Süresi Uzun',
   'Checkpoint yazma süresi uzun olduğunda disk darboğazını gösterir.',
   'cluster_metric', 'checkpoint_write_time', 'all_instances', '>',
   30000, 60000, 15, 'max', false, 30, true, 'system'),

  -- Bağlantı ve Kilitleme
  ('Aktif Bağlantı Yüksek',
   'Aktif bağlantı sayısı yüksek olduğunda bağlantı havuzu sorununu gösterir.',
   'activity_metric', 'active_count', 'all_instances', '>',
   50, 100, 1, 'last', false, 15, true, 'system'),

  ('Idle in TX Bağlantı',
   'Transaction içinde bekleyen bağlantılar tablo kilidine neden olabilir.',
   'activity_metric', 'idle_in_transaction_count', 'all_instances', '>',
   5, 20, 1, 'last', false, 10, true, 'system'),

  ('Lock Bekleme',
   'Kilit bekleyen sorgu sayısı yüksekse deadlock riski artar.',
   'activity_metric', 'waiting_count', 'all_instances', '>',
   3, 10, 1, 'last', false, 5, true, 'system'),

  -- Replikasyon
  ('Replay Lag (Byte)',
   'Replikasyon gecikmesi byte cinsinden yüksekse veri kaybı riski oluşur.',
   'replication_metric', 'replay_lag_bytes', 'all_instances', '>',
   52428800, 524288000, 1, 'max', false, 10, true, 'system'),

  ('Replay Lag (Süre)',
   'Replikasyon gecikmesi saniye cinsinden yüksekse standby güncel değildir.',
   'replication_metric', 'replay_lag_seconds', 'all_instances', '>',
   60, 300, 1, 'max', false, 10, true, 'system'),

  -- Database
  ('Deadlock Sayısı',
   'Son 15 dakikada tespit edilen deadlock sayısı.',
   'database_metric', 'deadlocks', 'all_instances', '>',
   1, 10, 15, 'sum', false, 30, true, 'system'),

  ('Temp Dosya Kullanımı',
   'Geçici dosya sayısı yüksekse work_mem yetersizliğini gösterir.',
   'database_metric', 'temp_files', 'all_instances', '>',
   50, 500, 15, 'sum', false, 30, true, 'system'),

  ('Rollback Oranı Yüksek',
   'Uygulama hatalarını veya kilitlenme sorunlarını gösterir.',
   'database_metric', 'rollback_ratio', 'all_instances', '>',
   5, 20, 15, 'avg', false, 30, true, 'system'),

  -- Statement
  ('Yavaş Sorgu Ortalama',
   'Sorgu ortalama çalışma süresi yüksekse performans sorunu vardır.',
   'statement_metric', 'avg_exec_time_ms', 'all_instances', '>',
   1000, 5000, 5, 'max', false, 15, true, 'system'),

  ('Temp Blok Kullanan Sorgu',
   'Çok geçici blok yazan sorgular bellek yetersizliğini gösterir.',
   'statement_metric', 'temp_blks_written', 'all_instances', '>',
   10000, 100000, 15, 'sum', false, 30, true, 'system'),

  -- Tablo
  ('Dead Tuple Oranı',
   'Ölü tuple oranı yüksekse vacuum gereklidir, sorgular yavaşlar.',
   'table_metric', 'dead_tuple_ratio', 'all_instances', '>',
   20, 50, 30, 'last', false, 60, true, 'system'),

  ('Sequential Scan Yoğun',
   'Çok sık sequential scan index eksikliğini gösterir.',
   'table_metric', 'seq_scan', 'all_instances', '>',
   10000, 100000, 60, 'sum', false, 60, true, 'system');
