-- V104: fiziksel sisme olcumunun dogruluk duzeltmeleri
--
-- V103'te kural satir basina bayti reltuples uzerinden hesapliyordu. Musteri
-- 2026-08-31'de bunun zayifligini fark ettirdi ve iki duzeltme cikti.
--
-- 1) YANLIS POZITIF: reltuples yalnizca VACUUM/ANALYZE ile guncellenir
-- ------------------------------------------------------------------
-- Aradaki surede tablo BUYURSE payda eski kalir ve sisme gibi gorunur:
--
--   Baslangic: 1M satir, reltuples=1M, 100 MB -> 100 B/satir
--   1M satir eklendi, ANALYZE yok:
--   Simdi:     2M satir, reltuples=1M, 200 MB -> 200 B/satir -> "2 kat sismis"
--
-- Tablo sismemis, sadece buyumus. Ve bu ortamda tablolarin uzun sure analiz
-- edilmeden kalabildigini biliyoruz (2026-08-28: 12.116 tablonun 4.478'i hic
-- analiz gormemis), yani senaryo teorik degil.
--
-- Cozum: satir sayisini toplanan delta'larla duzelt —
--   gercek_satir ~ reltuples + toplam(n_tup_ins_delta - n_tup_del_delta)
-- Bu veriler zaten fact.pg_table_stat_delta'da mevcut, yeni toplama gerekmiyor.
--
-- 2) FILLFACTOR: tasarim geregi bos alan sisme degildir
-- ----------------------------------------------------
-- fillfactor=70 olan bir tablo sayfalarinin %30'unu HOT update icin bilerek
-- bos birakir. Bunu okumadan o tabloyu "1.4 kat sismis" sayardik. reloptions
-- zaten toplaniyor; sadece fillfactor'u de ayristirmak gerekiyordu.
--
-- 3) Esik kolonu duzeltildi
-- ------------------------
-- V103 MB esigini bloat_min_rows kolonuna koymustu; o kolonun adi "satir"
-- diyor, degeri MB oluyordu ve UI'da yaniltirdi. Kendi kolonu aciliyor.

-- --- 1. fillfactor ---------------------------------------------------------

alter table control.table_relopts_snapshot
  add column if not exists fillfactor integer null;

comment on column control.table_relopts_snapshot.fillfactor is
  'Tablo-ozel fillfactor override (pg_class.reloptions). NULL = ayar yok, PostgreSQL varsayilani 100 gecerli. 100''den kucukse sayfalarin bir kismi HOT update icin BILEREK bos birakilir; fiziksel sisme hesabinda bu pay dusulmelidir yoksa tasarim geregi bos alan sisme sanilir (V104, PGSTAT-P0-042).';

-- --- 2. kurala kendi esik kolonu -------------------------------------------

alter table control.alert_rule
  add column if not exists space_bloat_min_wasted_mb integer null;

comment on column control.alert_rule.space_bloat_min_wasted_mb is
  'table_space_bloat kuralinda mutlak israf alt siniri (MB). Oran esigiyle BIRLIKTE aranir: kucuk bir tabloda 3 kat sisme birkac MB''dir ve mudahaleye degmez. NULL ise kod varsayilani (100 MB) kullanilir (V104, PGSTAT-P0-042).';

-- V103 bu degeri bloat_min_rows'a yazmisti; kendi kolonuna tasi ve eskisini
-- temizle ki dead_tuple_ratio ile ayni kolonu paylasip karismasin.
update control.alert_rule
   set space_bloat_min_wasted_mb = coalesce(space_bloat_min_wasted_mb, bloat_min_rows, 100),
       bloat_min_rows = null
 where evaluation_type = 'table_space_bloat';

-- --- 3. mesaj sablonuna dogruluk notlari -----------------------------------

update control.alert_message_template
   set message_template =
     E'{{table}} olması gerekenin {{bloat_ratio}} katı yer kaplıyor.\n' ||
     E'DB={{database}} · Şu an {{current_size}} · Sıkışık hâli {{compact_size}} · İsraf {{wasted_size}}\n' ||
     E'{{measurement_note}}\n\n' ||
     E'Teşhis: {{diagnosis}}\n' ||
     E'Aksiyon: {{bloat_action}}'
 where alert_code = 'table_space_bloat';
