-- =============================================================================
-- V033: Granular metric tipleri (statement/table/index) icin per-record
--       evaluation type'larina ozel zengin alert sablonlari
--
-- AlertRuleEvaluator templateCodeForType() metodu su mapping'i kullanir:
--   statement_metric + threshold → statement_threshold
--   statement_metric + spike     → statement_spike    (V032'de eklendi)
--   table_metric + threshold     → table_threshold
--   table_metric + spike         → table_spike
--   index_metric + threshold     → index_threshold
--   index_metric + spike         → index_spike
-- =============================================================================

insert into control.alert_message_template (alert_code, title_template, message_template, description) values

-- ============================================================================
-- STATEMENT (sorgu bazli)
-- ============================================================================
('statement_threshold',
 '[{{severity_upper}}] {{instance}} · Sorgu eşik aştı: {{rule_name}}',
 E'{{severity_emoji}} **{{rule_name}}** — Sorgu seviyesi eşik aşımı\n' ||
 E'📍 Instance: **{{instance}}**\n' ||
 E'📊 Metrik: `{{metric}}`\n' ||
 E'🎯 Eşik: {{operator}} {{threshold}} ({{severity}})\n' ||
 E'\n' ||
 E'**Eşiği aşan sorgu:**\n' ||
 E'• Database: `{{database}}`\n' ||
 E'• User: `{{user}}`\n' ||
 E'• Query ID: `{{queryid}}`\n' ||
 E'• Şu anki değer: **{{current_value}}** (son {{window}} dk)\n' ||
 E'\n' ||
 E'**Sorgu metni:**\n' ||
 E'```sql\n{{query_text}}\n```\n' ||
 E'\n' ||
 E'🕐 Başlangıç: {{started_at}}\n' ||
 E'💡 Birden fazla sorgu eşiği aştıysa pgstat alert detayında listeyi görün.',
 'Per-query threshold alert — instance toplamı yerine eşiği aşan sorgu net belirtilir'),

-- ============================================================================
-- TABLE (tablo bazli)
-- ============================================================================
('table_threshold',
 '[{{severity_upper}}] {{instance}} · Tablo eşik aştı: {{table}}',
 E'{{severity_emoji}} **{{rule_name}}** — Tablo seviyesi eşik aşımı\n' ||
 E'📍 Instance: **{{instance}}**\n' ||
 E'🗄️ Database: `{{database}}`\n' ||
 E'📊 Metrik: `{{metric}}`\n' ||
 E'🎯 Eşik: {{operator}} {{threshold}} ({{severity}})\n' ||
 E'\n' ||
 E'**Eşiği aşan tablo:**\n' ||
 E'• Tablo: `{{table}}`\n' ||
 E'• Şu anki değer: **{{current_value}}** (son {{window}} dk)\n' ||
 E'• Live tup: {{live_tup}}\n' ||
 E'• Dead tup: {{dead_tup}}\n' ||
 E'\n' ||
 E'🕐 Başlangıç: {{started_at}}\n' ||
 E'🔧 Aksiyon: `VACUUM (VERBOSE, ANALYZE) {{table}};`',
 'Per-table threshold alert — instance ortalaması yerine eşiği aşan tablo'),

('table_spike',
 '[{{severity_upper}}] {{instance}} · Tablo spike: {{table}}',
 E'{{severity_emoji}} **{{rule_name}}** — Tablo seviyesi ani artış\n' ||
 E'📍 Instance: **{{instance}}**\n' ||
 E'🗄️ Database: `{{database}}`\n' ||
 E'📊 Metrik: `{{metric}}`\n' ||
 E'\n' ||
 E'**Spike eden tablo:**\n' ||
 E'• Tablo: `{{table}}`\n' ||
 E'• Önceki dönem ({{window}} dk): **{{previous_value}}**\n' ||
 E'• Şu anki ({{window}} dk): **{{current_value}}**\n' ||
 E'• Artış: **%{{change_pct}}** (eşik: %{{threshold}})\n' ||
 E'\n' ||
 E'🕐 Başlangıç: {{started_at}}\n' ||
 E'💡 Detaylı liste için pgstat alert detayını kontrol edin.',
 'Per-table spike alert'),

-- ============================================================================
-- INDEX (index bazli)
-- ============================================================================
('index_threshold',
 '[{{severity_upper}}] {{instance}} · Index eşik aştı: {{index}}',
 E'{{severity_emoji}} **{{rule_name}}** — Index seviyesi eşik aşımı\n' ||
 E'📍 Instance: **{{instance}}**\n' ||
 E'🗄️ Database: `{{database}}`\n' ||
 E'📊 Metrik: `{{metric}}`\n' ||
 E'🎯 Eşik: {{operator}} {{threshold}} ({{severity}})\n' ||
 E'\n' ||
 E'**Eşiği aşan index:**\n' ||
 E'• Index: `{{index}}`\n' ||
 E'• Tablo: `{{table}}`\n' ||
 E'• Şu anki değer: **{{current_value}}** (son {{window}} dk)\n' ||
 E'\n' ||
 E'🕐 Başlangıç: {{started_at}}',
 'Per-index threshold alert'),

('index_spike',
 '[{{severity_upper}}] {{instance}} · Index spike: {{index}}',
 E'{{severity_emoji}} **{{rule_name}}** — Index seviyesi ani artış\n' ||
 E'📍 Instance: **{{instance}}**\n' ||
 E'🗄️ Database: `{{database}}`\n' ||
 E'📊 Metrik: `{{metric}}`\n' ||
 E'\n' ||
 E'**Spike eden index:**\n' ||
 E'• Index: `{{index}}`\n' ||
 E'• Önceki dönem ({{window}} dk): **{{previous_value}}**\n' ||
 E'• Şu anki ({{window}} dk): **{{current_value}}**\n' ||
 E'• Artış: **%{{change_pct}}** (eşik: %{{threshold}})\n' ||
 E'\n' ||
 E'🕐 Başlangıç: {{started_at}}',
 'Per-index spike alert')

on conflict (alert_code) do update
set title_template   = excluded.title_template,
    message_template = excluded.message_template,
    description      = excluded.description,
    is_system        = true;
