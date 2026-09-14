-- =============================================================================
-- V118 — Tablo esik alarmlarinin basligi ne olctugunu soylesin
--
-- V090 su basligi koydu:
--   '{{severity_emoji}} {{instance}} — {{table}} bloat'
--
-- Iki sorun var:
--
-- 1. "bloat" SABIT bir kelime, ama table_threshold sablonu metric_type=
--    'table_metric' + evaluation_type='threshold' olan HER kuralin sablonu
--    (bkz. AlertRuleEvaluator.templateCodeForType). Yani dead_tuple_ratio de,
--    seq scan da, tablo boyutu da ayni basligi aliyor ve hepsi "bloat" diyor.
--
--    dead_tuple_ratio icin bile yanlis: olu satir orani SISME DEGILDIR. Duz
--    VACUUM olu satirlari siler ama dosyayi buyuk birakir (olu satir ~0 iken
--    ciddi sisme olabilir); tersine 715 satirlik dim.role_ref'te %43 olu oran
--    birkac yuz KB eder, sisme degildir. Fiziksel sisme ayri bir kuralda
--    olculuyor (table_space_bloat, V103).
--
--    V092'nin kendi yorumu bu paylasimi biliyor ve mesaj govdesinde ayrim
--    yapiyor; baslikta yapilmamis.
--
-- 2. {{table}} yalnizca sema.tablo. Ayni sema.tablo adi bir instance'in birden
--    fazla veritabaninda bulunabiliyor (dogrulandi: pnrhouse.t_order hem prodb
--    hem testdb'de). Bildirimler icin koydugumuz "kimlik veritabani.sema.tablo
--    olmali" kurali (PGSTAT-P0-048 AC2) Alerts ekranindaki basliga da uygulanir.
--
-- Deger basliga KONMUYOR: '%' eki dead_tuple_ratio icin dogru, paylasilan
-- sablondaki diger metrikler icin yanlis olurdu. Deger zaten mesaj govdesinde.
-- =============================================================================

update control.alert_message_template
set title_template = '{{severity_emoji}} {{instance}} — {{database}}.{{table}}: {{rule_name}}',
    updated_at = now()
where alert_code = 'table_threshold';
