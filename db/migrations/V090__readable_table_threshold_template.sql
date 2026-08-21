-- V090: table_threshold alert mesaji daha okunur hale getirildi
--
-- Musteri geri bildirimi (2026-08-21): dead_tuple_ratio alerti acildiktan
-- sonra ayni anda cok sayida "Table=..., DB=..., Condition=..., Action=..."
-- satiri gelince (Telegram gibi bir kanalda ust uste) tek bakista hangi
-- alertin daha kritik oldugu, hangi instance/tabloda ne kadar kotu oldugu
-- ayirt edilemiyor. Eski format tum tablo-esik alertlerinde (table_threshold)
-- aynen kullaniliyordu.
--
-- Yeni format:
--   - Baslikta severity emoji + instance + tablo (AlertMessageRenderer'in
--     zaten urettigi severity_emoji placeholder'i kullanildi)
--   - Mesaj govdesinde "Field=Value" tekrarlari kaldirildi, deger/esik tek
--     satirda karsilastirmali gosterildi
--   - vacuum_ineffective context'i (P0-034, AlertRuleEvaluator.populateRecordCtx)
--     doluysa ek bir uyari satiri ekleniyor — bos ise placeholder Mustache
--     motoru tarafinda bos string olarak degistirilir (AlertMessageRenderer.render,
--     bilinmeyen/null placeholder icin kirilma yapmiyor), satir kendiliginden
--     anlamsiz gorunmesin diye vacuum_note alani AlertRuleEvaluator'da tam
--     satir olarak (bos veya doldurulmus) hazirlanacak.
--
-- Sadece table_threshold guncelleniyor — diger sablonlar (statement_threshold,
-- index_threshold vb.) bu migration'in kapsami disinda, ayri bir isle ele
-- alinacak (bkz. board).

update control.alert_message_template
set title_template = '{{severity_emoji}} {{instance}} — {{table}} bloat',
    message_template =
      E'Dead tuple orani: %{{current_value}} (esik: {{operator}} %{{threshold}}), pencere={{window}}m\n' ||
      E'DB={{database}}\n' ||
      E'{{vacuum_note}}' ||
      E'Aksiyon: tablo istatistiklerine ve autovacuum/index ihtiyacina bak.',
    updated_at = now()
where alert_code = 'table_threshold';

comment on column control.alert_message_template.message_template is
  'Mustache benzeri {{placeholder}} sablonu. table_threshold icin vacuum_note placeholder''i AlertRuleEvaluator.populateRecordCtx tarafindan doldurulur (bos string veya bir satirlik ek uyari) — V090.';
