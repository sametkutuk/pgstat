-- =============================================================================
-- V032: statement_spike alert_code icin zengin template
--
-- Per-query spike algilamasinda kullanilir. AlertRuleEvaluator,
-- statement_metric tipindeki bir kural spike yaparsa bu sablonu render eder.
-- Generic user_defined_rule sablonu degismez, sadece yeni bir kayit eklenir.
-- =============================================================================

insert into control.alert_message_template (alert_code, title_template, message_template, description) values
('statement_spike',
 '[{{severity_upper}}] {{instance}} · Sorgu spike: {{rule_name}}',
 E'{{severity_emoji}} **{{rule_name}}** — Sorgu seviyesi spike\n' ||
 E'📍 Instance: **{{instance}}**\n' ||
 E'📊 Metrik: `{{metric}}` (sorgu bazlı)\n' ||
 E'\n' ||
 E'**Spike eden sorgu:**\n' ||
 E'• Database: `{{database}}`\n' ||
 E'• User: `{{user}}`\n' ||
 E'• Query ID: `{{queryid}}`\n' ||
 E'• Önceki dönem ({{window}} dk): **{{previous_value}}**\n' ||
 E'• Şu anki ({{window}} dk): **{{current_value}}**\n' ||
 E'• Artış: **%{{change_pct}}** (eşik: %{{threshold}})\n' ||
 E'\n' ||
 E'**Sorgu metni:**\n' ||
 E'```sql\n{{spiking_query}}\n```\n' ||
 E'\n' ||
 E'🕐 Başlangıç: {{started_at}}\n' ||
 E'💡 Birden fazla sorgu spike yaptıysa pgstat alert detayında listeyi görebilirsiniz.',
 'Per-query istatistik spike alert şablonu (statement_metric kurallarinda kullanilir)')
on conflict (alert_code) do update
set title_template = excluded.title_template,
    message_template = excluded.message_template,
    description = excluded.description;
