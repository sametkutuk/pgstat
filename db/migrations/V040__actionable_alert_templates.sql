-- =============================================================================
-- V040: 5 aksiyon-odaklı alert mesaj şablonu
-- ActionableAlertEvaluator tarafından tetiklenir (UTC 04:00).
-- Her mesaj somut SQL aksiyon önerisi içerir.
-- =============================================================================

insert into control.alert_message_template (alert_code, title_template, message_template, description) values

('index_suspect_missing',
 '[WARNING] {{instance}} · Index gerekiyor: {{table}}',
 E'🟡 **Eksik Index Şüphesi**\n' ||
 E'📍 Instance: **{{instance}}** · DB: `{{database}}`\n' ||
 E'📊 Tablo: `{{table}}` ({{table_size_human}})\n' ||
 E'\n' ||
 E'**Tespit:**\n' ||
 E'• Seq scan: **{{seq_scans}}** (son 24h)\n' ||
 E'• Index scan: **{{idx_scans}}**\n' ||
 E'• Oran: {{seq_idx_ratio}}× (eşik: 100×)\n' ||
 E'• Seq tup read: {{seq_tup_read}} satır\n' ||
 E'\n' ||
 E'**Bu tabloya erişen sorgular:**\n' ||
 E'{{top_queries}}\n' ||
 E'\n' ||
 E'**Aksiyon:**\n' ||
 E'1. EXPLAIN (ANALYZE, BUFFERS) ile plan kontrol\n' ||
 E'2. Filtre/JOIN kolonlarına index ekle:\n' ||
 E'   `CREATE INDEX CONCURRENTLY ON {{table}} (kolon);`',
 'Tablo seq_scan/idx_scan oranı çok yüksek — index gerekiyor'),

('index_unused',
 '[INFO] {{instance}} · Kullanılmayan index: {{index}}',
 E'🔵 **Kullanılmayan Index**\n' ||
 E'📍 Instance: **{{instance}}** · DB: `{{database}}`\n' ||
 E'🔧 Index: `{{index}}` ({{index_size_human}})\n' ||
 E'\n' ||
 E'**Tespit:**\n' ||
E'• Son 30 gün tam gözlemde idx_scan = **0**\n' ||
 E'• Disk kullanımı: {{index_size_human}}\n' ||
 E'• Yazma maliyeti: her INSERT/UPDATE bu index''i günceller\n' ||
 E'\n' ||
 E'**Aksiyon:**\n' ||
 E'```sql\nDROP INDEX CONCURRENTLY {{index}};\n```\n' ||
 E'⚠️ UNIQUE/FK constraint için kullanılıyor olabilir — kontrol et.',
'Index 30 gün tam gözlemde hiç scan edilmedi — drop adayı'),

('high_temp_files',
 '[WARNING] {{instance}} · Yüksek temp file (work_mem yetersiz)',
 E'🟡 **Yüksek Temp File Üretimi**\n' ||
 E'📍 Instance: **{{instance}}** · DB: `{{database}}`\n' ||
 E'\n' ||
 E'**Tespit:**\n' ||
 E'• Temp file: **{{temp_files}}** dosya/saat\n' ||
 E'• Temp bytes: **{{temp_bytes_human}}**\n' ||
 E'• Mevcut work_mem: **{{work_mem}}**\n' ||
 E'\n' ||
 E'**Top temp üreten sorgular:**\n' ||
 E'{{top_temp_queries}}\n' ||
 E'\n' ||
 E'**Aksiyon:**\n' ||
 E'```sql\nBEGIN;\nSET LOCAL work_mem = ''{{suggested_work_mem}}'';\n-- ilgili sorguyu test et\nROLLBACK;\n```\n' ||
 E'⚠️ work_mem her connection × sort/hash için ayrılır.',
 'Sorgular sort/hash için disk kullanıyor → query-level work_mem testi önerilir'),

('idle_in_tx_time_high',
 '[WARNING] {{instance}} · Idle in transaction yüksek (%{{idle_pct}})',
 E'🟡 **Idle in Transaction Birikimi**\n' ||
 E'📍 Instance: **{{instance}}** · DB: `{{database}}`\n' ||
 E'\n' ||
 E'**Tespit:**\n' ||
 E'• Idle in tx süresi: **{{idle_in_tx_time_human}}** (son 1 saat)\n' ||
 E'• Toplam session: {{session_time_human}}\n' ||
 E'• Oran: **%{{idle_pct}}** (eşik: %30)\n' ||
 E'\n' ||
 E'**Aksiyon:**\n' ||
 E'```sql\nSELECT pid, usename, application_name,\n       now() - state_change AS idle_for, query\nFROM pg_stat_activity\nWHERE state = ''idle in transaction''\n  AND now() - state_change > interval ''5 minutes'';\n```\n' ||
 E'`idle_in_transaction_session_timeout` parametresini set etmeyi düşün.',
 'Idle in transaction süresi yüksek — connection pool sızıntı olabilir'),

('replication_slot_inactive',
 '[WARNING] {{instance}} · Inactive slot WAL tutuyor: {{slot_name}}',
 E'🟡 **Inactive Replication Slot**\n' ||
 E'📍 Instance: **{{instance}}**\n' ||
 E'🔗 Slot: `{{slot_name}}` ({{slot_type}})\n' ||
 E'\n' ||
 E'**Tespit:**\n' ||
 E'• Slot 1 saattir aktif değil\n' ||
 E'• WAL tutuyor: **{{slot_lag_human}}**\n' ||
 E'\n' ||
 E'**Aksiyon:**\n' ||
 E'```sql\n-- Slot durumunu kontrol et:\nSELECT * FROM pg_replication_slots\nWHERE slot_name = ''{{slot_name}}'';\n\n-- Gereksizse drop et:\nSELECT pg_drop_replication_slot(''{{slot_name}}'');\n```\n' ||
 E'⚠️ Aktif kullanılan slot''u silme!',
 'Inactive replication slot WAL tutuyor → drop edilmeli')

on conflict (alert_code) do update
set title_template = excluded.title_template,
    message_template = excluded.message_template,
    description = excluded.description;
