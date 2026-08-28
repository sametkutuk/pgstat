-- V098: granular kurallarin eski instance-bazli alert'lerini kapat
--
-- PGSTAT-P0-039 ile granular kurallar (table_metric / index_metric /
-- statement_metric threshold) kayit basina ayri alert acmaya basladi. Alert
-- anahtari degisti:
--
--   eski: rule:14:instance:2
--   yeni: rule:14:instance:2:rec:db:16385:rel:2128608
--
-- Eski anahtarlar artik hicbir kod yolu tarafindan guncellenmiyor, yani kendi
-- kendilerine resolve olamazlar — acik kalir ve yeni kayit-alert'lerinin
-- yaninda "hangisi gecerli" karisikligi yaratirlardi. Bu yuzden tek seferde
-- kapatiliyorlar (musteri karari 2026-08-28: migration ile resolve edilsin,
-- yeni tablo-bazli alert'ler temiz acilsin).
--
-- Neden veri kaybi degil: kapanan alert'in isaret ettigi kayit gercekten hala
-- esigin ustundeyse, bir sonraki degerlendirme onu kendi anahtariyla ve
-- guncel teshisiyle yeniden acar. Kapanma, sorunun bittigi anlamina gelmiyor;
-- sadece o alert satirinin artik takip edilmedigi anlamina geliyor.
--
-- Kapsam bilincli olarak dar: sadece user_rule kaynakli, granular metric
-- tipindeki kurallara ait, ":rec:" icermeyen ACIK alert'ler. Instance bazli
-- metrikler (cluster_metric vb.) hala tek anahtar kullaniyor ve bu
-- migration'dan etkilenmemeli.

update ops.alert a
   set status = 'resolved',
       resolved_at = now(),
       last_seen_at = now(),
       message = a.message || E'\n\n[Sistem notu] Bu alarm, her tablo/indeks/sorgu'
              || ' icin ayri alarm acan yeni surumle degistirildi (PGSTAT-P0-039).'
              || ' Sorun devam ediyorsa bir sonraki degerlendirmede kendi alarmiyla'
              || ' yeniden acilir.'
 where a.status <> 'resolved'
   and a.alert_source = 'user_rule'
   -- Regex, LIKE'dan daha kesin: kural id'sinin gercekten sayisal oldugunu
   -- garanti eder. Asagidaki ::bigint cast'i bu olmadan, planlayici kosullari
   -- yeniden siralarsa eslesmeyen bir satirda calisip migration'i hataya
   -- dusurebilirdi.
   and a.alert_key ~ '^rule:[0-9]+:instance:[0-9]+$'
   -- Kural, alert_key'den PARSE edilir; a.rule_id'ye guvenilemez cunku bu
   -- alert'leri yazan eski kod yolu (AlertRepository.upsert'in 8 argumanli
   -- overload'i) insert kolon listesinde rule_id tasimiyordu, yani kolon bu
   -- satirlarda NULL. rule_id uzerinden join yazilsaydi migration hicbir satir
   -- guncellemezdi. Anahtar formati sabit: 'rule:{ruleId}:instance:{pk}'.
   and exists (
     select 1
       from control.alert_rule r
      where r.rule_id = nullif(split_part(a.alert_key, ':', 2), '')::bigint
        and r.metric_type in ('table_metric', 'index_metric', 'statement_metric')
        and r.evaluation_type = 'threshold'
   );

-- Kayit-bazli anahtarlarda prefix aramasi yapiliyor
-- (AlertRepository.openAlertKeysWithPrefix): "alert_key like 'rule:14:instance:2:rec:%'".
-- uq_alert_key zaten bir btree unique index; text_pattern_ops olmadan LIKE
-- prefix aramasi bu index'i C-disi collation'larda kullanamaz.
create index if not exists ix_alert_key_pattern
  on ops.alert (alert_key text_pattern_ops)
  where status <> 'resolved';

comment on index ops.ix_alert_key_pattern is
  'Granular kurallarda bir instance''in tum kayit-alert''lerini onek ile bulmak icin (V098, PGSTAT-P0-039). Kismi index: sadece acik alert''ler sorgulaniyor.';
