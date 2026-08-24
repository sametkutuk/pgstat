-- V092: dead_tuple_ratio icin kanita dayali teshis+aksiyon satiri
--
-- Musteri talebi (2026-08-24): "aksiyon onerisi hep aynı, nedene göre
-- değişmeli" + "teşhis satırı da eklensin" + "net ve doğru olmalı çünkü
-- datamız var". V090'da sabit "Aksiyon: tablo istatistiklerine ve
-- autovacuum/index ihtiyacina bak." her durumda aynen kullaniliyordu.
--
-- Piyasa arastirmasina dayanan 5 senaryolu karar agaci (bkz.
-- docs/bloat-diagnosis-decision-tree.md, kaynaklar orada listeli) artik
-- AlertRuleEvaluator.diagnoseBloat() tarafindan hesaplanip ctx'e
-- {{diagnosis}} ve {{bloat_action}} olarak yaziliyor — sadece
-- dead_tuple_ratio kurallari icin (diger table_metric kurallari icin
-- kod tarafinda jenerik fallback set edilir, sablon kirilmaz).
--
-- {{diagnosis}} bos string olabilir (non-bloat kurallarda) — tam satir
-- (icinde \n dahil, ya da tamamen bos) olarak AlertRuleEvaluator'da
-- hazirlaniyor (V090'daki vacuum_note desenine benzer), boylece bos
-- placeholder/anlamsiz bos satir gorunmez.

update control.alert_message_template
set message_template =
      E'Dead tuple orani: %{{current_value}} (esik: {{operator}} %{{threshold}}), pencere={{window}}m\n' ||
      E'DB={{database}}\n' ||
      E'{{vacuum_note}}' ||
      E'{{diagnosis}}' ||
      E'Aksiyon: {{bloat_action}}',
    updated_at = now()
where alert_code = 'table_threshold';
