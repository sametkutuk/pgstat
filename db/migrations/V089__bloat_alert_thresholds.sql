-- V089: dead_tuple_ratio alert kurali icin uc bacakli esik kolonlari
--
-- Mevcut dead_tuple_ratio degerlendirmesi tek kosuldu: sadece oran (%),
-- ve n_live_tup+n_dead_tup > 1000 sartiyla kucuk tablolari (orn. ops.alert,
-- 592 satir, %22 dead tuple) tamamen atliyordu. Musteri raporu (2026-08-21):
-- pgstat'in kendi merkezi DB'sinde ops.alert/ops.notification_log bloat'lu
-- ama hicbir alert gelmedi.
--
-- Piyasa arastirmasi (check_postgres, Datadog, pganalyze, Citus) sonucu:
-- olgun araclar tek esikli oran modeli kullanmiyor; oran+mutlak-sayi+
-- sureklilik/trend kombinasyonu standart. Uc bacakli model:
--   A) oran + minimum satir sayisi (mevcut mantik, esik dusuruldu)
--   B) mutlak dead-tuple sayisi (satir sayisindan bagimsiz, kucuk-ama-
--      kritik tablolari yakalar)
--   C) "autovacuum calisiyor ama etkisiz" sinyali (yeni bulgu tipi)
--
-- Kolonlar nullable: kullanici deger girerse o kullanilir, NULL ise kod
-- tarafinda best-practice default uygulanir (ayni desen: AlertRules.tsx'teki
-- adaptive kuralin "Mutlak Alt Esik — opsiyonel" alani). Sadece
-- metric_name='dead_tuple_ratio' kurallari bu kolonlari kullanir, diger
-- metric tipleri etkilenmez.

alter table control.alert_rule
  add column if not exists bloat_min_rows bigint null,
  add column if not exists bloat_abs_dead_tup bigint null,
  add column if not exists bloat_vacuum_ineffective_count int null;

comment on column control.alert_rule.bloat_min_rows is
  'Bacak A (oran): degerlendirmeye alinmasi icin minimum n_live_tup+n_dead_tup. NULL ise kod varsayilani (100) kullanilir. Sadece dead_tuple_ratio kurallari icin anlamlidir.';
comment on column control.alert_rule.bloat_abs_dead_tup is
  'Bacak B (mutlak sayi): satir sayisindan bagimsiz, n_dead_tup bu esigi gecerse alert (oran esigine bakilmaz). NULL ise kod varsayilani (500) kullanilir.';
comment on column control.alert_rule.bloat_vacuum_ineffective_count is
  'Bacak C (vacuum yetersiz): son pencerede bu sayidan fazla autovacuum calismis olup dead_tup hala dusmuyorsa ayrica isaretlenir. NULL ise kod varsayilani (20) kullanilir.';

alter table control.alert_rule
  add constraint ck_alert_rule_bloat_min_rows check (bloat_min_rows is null or bloat_min_rows >= 0),
  add constraint ck_alert_rule_bloat_abs_dead_tup check (bloat_abs_dead_tup is null or bloat_abs_dead_tup >= 0),
  add constraint ck_alert_rule_bloat_vacuum_ineffective check (bloat_vacuum_ineffective_count is null or bloat_vacuum_ineffective_count >= 0);
