-- V101: bayat istatistik alarmi
--
-- Musteri talebi (2026-08-27): "analyze cok eskiyse bunu da alert olarak
-- uretmek gerekmiyor mu, sistem sagligi icin".
--
-- Asil zarar bizim teshislerimizde degil SORGU PLANLARINDA: planner join
-- boyutlarini istatistiklerden hesaplar, bayat istatistik yanlis plan uretir.
-- Uretimde bunun ornegi gorulmustu — 62 satir sanilan bir tablo gercekte
-- 4.593.352 satirdi.
--
-- ESIK NEDEN SABIT DEGIL
-- ---------------------
-- Ilk tasarim "X satir degismis ve Y gundur analiz yok" seklinde sabit
-- sayilar kullaniyordu. 2026-08-28'de ogrendik ki bu yanlis soru: bir tablonun
-- istatistiklerinin bayat SAYILIP sayilmayacagina PostgreSQL'in kendi
-- autoanalyze esigi karar verir:
--
--   anlthresh = autovacuum_analyze_threshold + autovacuum_analyze_scale_factor * reltuples
--
-- t_ets_hotel_transaction_log 29 gundur analiz gormemisti ve bu TAMAMEN
-- normaldi: gercek esigi 1.520.266, birikmis degisim 516.298, yani esigin
-- %34'u. Sabit bir "10.000 satir" esigi bu tabloyu yanlislikla isaretlerdi.
--
-- Bu yuzden kural kendi sabitini tasimiyor, PostgreSQL'in esigini yeniden
-- hesapliyor ve sunu soruyor: esik ASILDIGI HALDE autoanalyze ne kadar
-- suredir calismadi? Esik asilmamissa ortada sorun yoktur; asilmissa ve uzun
-- suredir calismiyorsa gercekten bir aksaklik vardir.
--
-- Bu ayni zamanda kendi kendini kalibre eder: instance'in kendi
-- autovacuum_analyze_* ayarlarini kullanir, tablo boyutuna gore olceklenir ve
-- ayar degistiginde esik de degisir.
--
-- warning_threshold / critical_threshold burada SAAT cinsindendir: esik
-- asildiktan sonra autoanalyze'in calismamasina ne kadar tahammul edilecegi.

alter table control.alert_rule
  drop constraint if exists ck_alert_rule_eval_type;

alter table control.alert_rule
  add constraint ck_alert_rule_eval_type
  check (evaluation_type in (
    'threshold',
    'alltime_high', 'alltime_low',
    'day_over_day', 'week_over_week',
    'spike',
    'flatline',
    'hourly_pattern',
    'adaptive',
    'stale_statistics'
  ));

insert into control.alert_rule (
  rule_name, description, metric_type, metric_name, evaluation_type,
  aggregation, condition_operator, warning_threshold, critical_threshold,
  evaluation_window_minutes, cooldown_minutes, auto_resolve, is_enabled
)
select
  'Bayat İstatistik',
  'PostgreSQL''in kendi autoanalyze eşiği aşıldığı halde ANALYZE uzun süredir çalışmamış tabloları bildirir. Eşik sabit değil, instance''ın autovacuum_analyze_threshold/scale_factor ayarlarından ve tablonun reltuples değerinden hesaplanır. Uyarı/kritik değerleri SAAT cinsindendir.',
  'table_metric', 'stale_statistics', 'stale_statistics',
  -- aggregation kullanilmiyor (bespoke sorgu), ama kolon NOT NULL
  'max', '>', 24, 72,
  30, 360, true, true
where not exists (
  select 1 from control.alert_rule where evaluation_type = 'stale_statistics'
);

insert into control.alert_message_template (alert_code, title_template, message_template, description)
select 'stale_statistics',
  '{{severity_emoji}} {{instance}} — {{stale_count}} tablonun istatistikleri bayat',
  E'{{instance}} üzerinde {{stale_count}} tabloda autoanalyze eşiği aşıldığı halde ANALYZE çalışmamış.\n\n' ||
  E'{{stale_list}}\n\n' ||
  E'Bayat istatistik sorgu planlarını bozar: planner join boyutlarını bu sayılardan hesaplar.\n' ||
  E'Aksiyon: {{stale_action}}',
  'PostgreSQL''in kendi autoanalyze eşiği aşılmasına rağmen uzun süredir analiz edilmemiş tablolar (V101, PGSTAT-P1-012)'
where not exists (
  select 1 from control.alert_message_template where alert_code = 'stale_statistics'
);
