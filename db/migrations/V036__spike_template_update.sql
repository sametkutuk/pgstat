-- =============================================================================
-- V036: statement_spike template guncelleme — dagilmis artis durumunu da kapsar
--
-- Eski template sadece tek sorgu spike'i icin yazilmisti. Yeni template:
-- - Tek sorgu spike ettiyse: sorgu detayi gosterir
-- - Birden fazla sorgudan gelen dagilmis artis: instance toplam + top contributor
-- =============================================================================

update control.alert_message_template
set message_template =
 E'{{severity_emoji}} **{{rule_name}}** — Sorgu seviyesi spike\n' ||
 E'📍 Instance: **{{instance}}**\n' ||
 E'📊 Metrik: `{{metric}}` (sorgu bazlı)\n' ||
 E'\n' ||
 E'**Önceki dönem ({{window}} dk):** {{previous_value}}\n' ||
 E'**Şu anki ({{window}} dk):** {{current_value}}\n' ||
 E'**Artış:** %{{change_pct}} (eşik: %{{threshold}})\n' ||
 E'\n' ||
 E'**En çok katkı yapan sorgu:**\n' ||
 E'• Database: `{{database}}`\n' ||
 E'• User: `{{user}}`\n' ||
 E'• Query ID: `{{queryid}}`\n' ||
 E'```sql\n{{spiking_query}}\n```\n' ||
 E'\n' ||
 E'🕐 Başlangıç: {{started_at}}\n' ||
 E'💡 Birden fazla sorgu spike yaptıysa pgstat alert detayında listeyi görebilirsiniz.'
where alert_code = 'statement_spike';
