-- V102: gece boyut anlik goruntusune satir sayisi ekleniyor
--
-- Amac: fiziksel tablo sismesini EXTENSION KURMADAN olcebilmek.
--
-- Musteri kisiti (2026-08-31): "her izleyecegimiz instance'a bu extension'lari
-- kuramayiz". pgstattuple ve pg_freespacemap tek kesin olcum yollari ama ikisi
-- de contrib extension; ustelik pgstattuple tam tablo taramasi yapiyor
-- (30M satirlik tabloda kabul edilemez).
--
-- Klasik alternatif, pg_stats.avg_width'ten satirin "olmasi gereken"
-- genisligini TAHMIN eden bloat sorgusu. Iki zayifligi var ve biri bizim icin
-- kritik: hic ANALYZE edilmemis tabloda avg_width = 0 oldugu icin sonuc %0
-- bloat cikiyor. 2026-08-31 olcumunde izledigimiz 12.116 tablonun 4.478'i tam
-- olarak bu durumdaydi — yani tahmin yontemi bilmedigimiz yerlerde kor.
--
-- Bizim elimizde daha iyisi var: AYNI TABLOYU TEKRAR TEKRAR OLCUYORUZ.
--
--   satir_basina_bayt = table_size_bytes / reltuples
--
-- Bu deger tablonun kendi tarihindeki EN DUSUK degerine kiyaslaninca, sisme
-- bir tahmin degil IKI OLCUM ARASINDAKI FARK olur. Uretimde dogrulandi:
-- agg.pg_table_stat_hourly_202608 VACUUM FULL oncesi 2432 MB / 121.162 satir
-- (~20.032 bayt/satir), sonrasi 41 MB / ayni satir sayisi (~338 bayt/satir).
-- 59 kat fark; avg_width'e, ANALYZE'a ya da fillfactor varsayimina hic ihtiyac
-- duymadan.
--
-- reltuples neden BURAYA: fact.pg_table_stat_delta'da da var ama onun
-- retention'i 7-14 gun. Bu tablo gece toplanir ve ~4 ay yasar, yani tablonun
-- sikisik halini uzun gecmiste aramaya elverisli tek yer burasi.
--
-- table_size_bytes zaten sadece heap'i olcuyor (index ve TOAST ayri
-- kolonlarda) — tablo sismesi icin dogru payda.

alter table fact.pg_relation_size_snapshot
  add column if not exists reltuples bigint null;

comment on column fact.pg_relation_size_snapshot.reltuples is
  'pg_class.reltuples — katalogdaki satir sayisi tahmini. table_size_bytes ile birlikte "satir basina bayt" verir; bu degerin tablonun kendi tarihsel minimumuna orani, fiziksel sismenin extension gerektirmeyen OLCUMUDUR. NULL ise bilinmiyor (PG14+ -1 sentinel toplama aninda NULL''a cevrilir) ve o gozlem yogunluk hesabina girmez (V102, PGSTAT-P0-042).';

-- Yogunluk sorgusu tablo bazinda gecmise bakiyor; mevcut index
-- (instance_pk, total_size_bytes desc, snapshot_ts desc) bu erisim desenine
-- uymuyor.
create index if not exists ix_pg_relation_size_table_hist
  on fact.pg_relation_size_snapshot (instance_pk, dbid, schemaname, relname, snapshot_ts desc)
  where reltuples is not null and table_size_bytes is not null;
