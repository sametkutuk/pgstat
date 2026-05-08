-- =============================================================================
-- V056: Concise alert templates
-- Keep alert text short and ensure templates only use populated placeholders.
-- Full diagnostics stay in details_json.
-- =============================================================================

with v(alert_code, title_template, message_template, description) as (
  values
  ('index_suspect_missing',
   '[WARNING] {{instance}} - Index adayi: {{table}}',
   E'Tablo: {{table}} ({{table_size_human}}), DB: {{database}}\n' ||
   E'Son 24h: seq_scan={{seq_scans}}, idx_scan={{idx_scans}}, oran={{seq_idx_ratio}}x, seq_tup={{seq_tup_read}}\n' ||
   E'Aksiyon: EXPLAIN (ANALYZE, BUFFERS) ile plan kontrol et; filtre/JOIN kolonlari icin CREATE INDEX CONCURRENTLY degerlendir.\n' ||
   E'Top sorgular:\n{{top_queries}}',
   'Seq scan agirligi yuksek tablo icin index adayi'),

  ('index_unused',
   '[INFO] {{instance}} - Kullanilmayan index: {{index}}',
   E'Index: {{index}}, DB: {{database}}, boyut={{index_size_human}}\n' ||
   E'Son 30 gun tam gozlemde idx_scan=0.\n' ||
   E'Aksiyon: UNIQUE/FK kontrolunden sonra gerekiyorsa DROP INDEX CONCURRENTLY degerlendir.',
   'Tam gozlem penceresinde kullanilmayan index'),

  ('high_temp_files',
   '[WARNING] {{instance}} - Temp file yuksek: {{database}}',
   E'DB: {{database}}, temp_files={{temp_files}}/saat, temp={{temp_bytes_human}}\n' ||
   E'work_mem={{work_mem}}, max_connections={{max_connections}}\n' ||
   E'Aksiyon: global work_mem onermiyoruz; once query/session bazli test et:\n' ||
   E'`SET LOCAL work_mem = ''{{suggested_work_mem}}'';`\n' ||
   E'Top sorgular:\n{{top_temp_queries}}',
   'Temp file yuksek; query-level work_mem testi onerilir'),

  ('idle_in_tx_time_high',
   '[WARNING] {{instance}} - Idle in tx yuksek: {{database}}',
   E'DB: {{database}}, idle_in_tx={{idle_in_tx_time_human}}, session={{session_time_human}}, oran=%{{idle_pct}}\n' ||
   E'Aksiyon: pg_stat_activity icinde idle in transaction oturumlarini ve connection pool davranisini kontrol et.',
   'Idle in transaction orani yuksek'),

  ('replication_slot_inactive',
   '[WARNING] {{instance}} - Inactive slot: {{slot_name}}',
   E'Slot: {{slot_name}} ({{slot_type}}), WAL tutulan={{slot_lag_human}}\n' ||
   E'Aksiyon: slot halen gerekli mi kontrol et; gereksizse pg_drop_replication_slot kullan.',
   'Inactive replication slot WAL tutuyor'),

  ('high_connection_usage',
   '[{{severity_upper}}] {{instance}} - Connection usage %{{usage_pct}}',
   E'Aktif baglanti: {{value}}/{{max_value}} (%{{usage_pct}})\n' ||
   E'Aksiyon: pg_stat_activity state dagilimini ve pool limitlerini kontrol et.',
   'numbackends / max_connections orani esik ustu'),

  ('long_running_query',
   '[WARNING] {{instance}} - Uzun sorgu: {{duration_seconds}}s',
   E'DB: {{database}}, pid={{pid}}, user={{username}}, sure={{duration_seconds}}s\n' ||
   E'Query: {{query_snippet}}\n' ||
   E'Aksiyon: gerekirse once pg_cancel_backend({{pid}}) degerlendir.',
   'Esik sureyi asan aktif sorgu'),

  ('replication_lag',
   '[{{severity_upper}}] {{instance}} - Replication lag {{lag_human}}',
   E'Lag: {{lag_human}} ({{lag_bytes}} bytes), replay={{replay_lag_seconds}}\n' ||
   E'Esik: warning {{warning_threshold}}, critical {{critical_threshold}}\n' ||
   E'Aksiyon: standby disk/I/O, network ve replay durumunu kontrol et.',
   'Streaming replication gecikmesi'),

  ('high_bloat_ratio',
   '[INFO] {{instance}} - Bloat: {{relation}} %{{bloat_pct}}',
   E'Tablo: {{relation}}, DB: {{database}}, dead_tuple=%{{bloat_pct}}, boyut={{total_size}}\n' ||
   E'Aksiyon: autovacuum ayarlari ve vacuum/repack ihtiyacini kontrol et.',
   'Dead tuple orani yuksek'),

  ('lock_contention',
   '[WARNING] {{instance}} - Lock wait {{wait_seconds}}s',
   E'PID={{pid}}, wait={{wait_seconds}}s, mode={{lock_mode}}, relation={{relation}}\n' ||
   E'Aksiyon: SELECT pg_blocking_pids({{pid}}); ile blocker oturumu bul.',
   'Lock bekleme suresi esik ustu')
)
update control.alert_message_template t
set title_template = v.title_template,
    message_template = v.message_template,
    description = v.description,
    updated_at = now()
from v
where t.alert_code = v.alert_code;
