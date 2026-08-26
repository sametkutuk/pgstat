-- V095: control.table_relopts_snapshot'a ayristirilmis cost-override kolonlari
--
-- PGSTAT-P1-011 (autovacuum kanit katmani) icin gerekli. V093 bu tabloyu
-- olustururken sadece autovacuum_enabled'i ayristirmis, geri kalan her seyi
-- ham metin olarak reloptions_raw'a birakmisti. Ama dead_tuple_ratio
-- teshisinin "cost_delay dusur" onerisi, ETKIN cost ayarini bilmek zorunda
-- ve bu zincirin ILK adimi tablo-ozel override:
--
--   1. Tablo override (bu tablo) >= 0  -> etkin deger budur
--      -1 veya yok                     -> adim 2
--   2. Global autovacuum_vacuum_cost_* -> etkin deger; -1 ise adim 3
--   3. Global vacuum_cost_*            -> etkin deger
--
-- Ham metinden her okumada parse etmek yerine (kirilgan, her sorguda
-- tekrar eden is) toplama aninda bir kez ayristirip kolona yaziyoruz.
-- reloptions_raw yine korunuyor — hem geriye donuk uyumluluk hem de
-- ayristirilmayan diger secenekler (fillfactor vb.) icin.
--
-- Nullable secildi cunku "override yok" ile "override var ve degeri 0"
-- farkli seylerdir; ayrica -1 sentinel'i de anlamli bir deger olarak
-- saklanir (adim 2'ye gecis sinyali).

alter table control.table_relopts_snapshot
  add column if not exists autovacuum_vacuum_cost_delay integer null,
  add column if not exists autovacuum_vacuum_cost_limit integer null;

comment on column control.table_relopts_snapshot.autovacuum_vacuum_cost_delay is
  'Tablo-ozel autovacuum_vacuum_cost_delay override (ms). NULL = reloptions''ta yok (global gecerli). -1 = sentinel, global vacuum_cost_delay kullanilir. V095, PGSTAT-P1-011.';

comment on column control.table_relopts_snapshot.autovacuum_vacuum_cost_limit is
  'Tablo-ozel autovacuum_vacuum_cost_limit override. NULL = reloptions''ta yok (global gecerli). -1 = sentinel, global vacuum_cost_limit kullanilir. V095, PGSTAT-P1-011.';

-- Mevcut satirlarda ham metinden geriye donuk doldurma. Yeni satirlar
-- zaten collector tarafindan ayristirilmis olarak yazilacak; bu backfill
-- sadece migration anindaki mevcut kayitlar icin.
--
-- reloptions_raw formati: "{autovacuum_vacuum_cost_delay=10,fillfactor=90}"
-- veya kume parantezleri olmadan virgulle ayrilmis. substring() ile
-- ilgili anahtarin degerini cekiyoruz; eslesmezse NULL kalir.
update control.table_relopts_snapshot
set autovacuum_vacuum_cost_delay =
      nullif(substring(reloptions_raw from 'autovacuum_vacuum_cost_delay=(-?[0-9]+)'), '')::integer,
    autovacuum_vacuum_cost_limit =
      nullif(substring(reloptions_raw from 'autovacuum_vacuum_cost_limit=(-?[0-9]+)'), '')::integer
where reloptions_raw is not null
  and (reloptions_raw like '%autovacuum_vacuum_cost_delay=%'
       or reloptions_raw like '%autovacuum_vacuum_cost_limit=%');
