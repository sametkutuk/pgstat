-- =============================================================================
-- V036: Tum alert template'lerine metric_description ve eval_description ekleme
-- + statement_spike template guncelleme — dagilmis artis durumunu da kapsar
--
-- Her alert mesajinda artik:
-- - Metrigin ne oldugu Turkce aciklama (metric_description)
-- - Degerlendirme tipinin aciklamasi (eval_description)
-- - Onceki donem vs su anki karsilastirma (spike/trend icin)
-- =============================================================================

-- user_defined_rule — generic sablon (tum kurallar icin fallback)
update control.alert_message_template
set message_template =
 E'{{severity_emoji}} **{{rule_name}}**\n' ||
 E'📍 Instance: **{{instance}}**\n' ||
 E'📊 Metrik: `{{metric}}` = **{{value}}** ({{aggregation}}, son {{window}} dk)\n' ||
 E'ℹ️ {{metric_description}}\n' ||
 E'🔍 Tespit: {{eval_description}}\n' ||
 E'🎯 Eşik: {{operator}} {{threshold}} ({{severity}})\n' ||
 E'{{top_queries_summary}}\n' ||
 E'🕐 Başlangıç: {{started_at}}'
where alert_code = 'user_defined_rule';

-- statement_spike — per-query spike
update control.alert_message_template
set message_template =
 E'{{severity_emoji}} **{{rule_name}}**\n' ||
 E'📍 Instance: **{{instance}}**\n' ||
 E'📊 `{{metric}}` — {{metric_description}}\n' ||
 E'\n' ||
 E'**Son {{window}} dk vs önceki {{window}} dk:**\n' ||
 E'• Önceki: **{{previous_value}}** → Şu anki: **{{current_value}}** (%{{change_pct}} artış)\n' ||
 E'\n' ||
 E'**Top sorgular:**\n' ||
 E'{{top_queries_summary}}\n' ||
 E'\n' ||
 E'🕐 {{started_at}}'
where alert_code = 'statement_spike';

-- statement_threshold — per-query esik asimi
update control.alert_message_template
set message_template =
 E'{{severity_emoji}} **{{rule_name}}**\n' ||
 E'📍 Instance: **{{instance}}**\n' ||
 E'📊 `{{metric}}` — {{metric_description}}\n' ||
 E'🎯 Eşik: {{operator}} {{threshold}} ({{severity}})\n' ||
 E'\n' ||
 E'**Top sorgular:**\n' ||
 E'{{top_queries_summary}}\n' ||
 E'\n' ||
 E'🕐 {{started_at}}'
where alert_code = 'statement_threshold';

-- table_threshold
update control.alert_message_template
set message_template =
 E'{{severity_emoji}} **{{rule_name}}** — Tablo seviyesi eşik aşımı\n' ||
 E'📍 Instance: **{{instance}}**\n' ||
 E'📊 Metrik: `{{metric}}`\n' ||
 E'ℹ️ {{metric_description}}\n' ||
 E'🎯 Eşik: {{operator}} {{threshold}} ({{severity}})\n' ||
 E'\n' ||
 E'**Eşiği aşan tablo:**\n' ||
 E'• Database: `{{database}}`\n' ||
 E'• Tablo: `{{table}}`\n' ||
 E'• Şu anki değer: **{{current_value}}** (son {{window}} dk)\n' ||
 E'• Live tup: {{live_tup}} · Dead tup: {{dead_tup}}\n' ||
 E'\n' ||
 E'🕐 Başlangıç: {{started_at}}\n' ||
 E'🔧 Aksiyon: `VACUUM (VERBOSE, ANALYZE) {{table}};`'
where alert_code = 'table_threshold';

-- table_spike
update control.alert_message_template
set message_template =
 E'{{severity_emoji}} **{{rule_name}}** — Tablo seviyesi ani artış\n' ||
 E'📍 Instance: **{{instance}}**\n' ||
 E'📊 Metrik: `{{metric}}`\n' ||
 E'ℹ️ {{metric_description}}\n' ||
 E'\n' ||
 E'**Karşılaştırma (son {{window}} dk vs önceki {{window}} dk):**\n' ||
 E'• Tablo: `{{table}}`\n' ||
 E'• Önceki dönem: **{{previous_value}}**\n' ||
 E'• Şu anki: **{{current_value}}**\n' ||
 E'• Artış: **%{{change_pct}}** (eşik: %{{threshold}})\n' ||
 E'\n' ||
 E'🕐 Başlangıç: {{started_at}}'
where alert_code = 'table_spike';
