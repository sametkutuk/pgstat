-- V110: boyut gozlemine KAYNAK bilgisi — taban havuzu ayirt edilebilsin
--
-- Dis inceleme (2026-08-31) taban gecerliligi kapisinda iki eksik gosterdi.
--
-- 1) KAYNAK UYGUNLUGU (kacirilan seçenek)
-- ---------------------------------------
-- fact.pg_relation_size_snapshot'a iki farkli yerden yaziliyor:
--   - gece anlik goruntusu (planli, gunde bir, tum tablolar)
--   - gun ici izleme (30 dakikada bir, YALNIZCA acik bloat alarmi olan
--     tablolar — V105/PGSTAT-P0-045)
--
-- Ikincisi taban hesabina GIRMEMELI. O gozlemler tablo zaten alarm verdigi
-- icin toplaniyor; yani sistematik olarak sismis duruma yakin anlari
-- orneklerler ve yogun aralikli olduklari icin gurultuyle tabani asagi
-- cekebilirler. Gorevleri guncel durumu ve kaliciligi dogrulamak, tabani
-- tanimlamak degil.
--
-- 2) HAM min YANLIS POZITIF URETEBILIR
-- ------------------------------------
-- bytes_per_row = table_size_bytes / satir_sayisi. Payda bir TAHMIN. Tek bir
-- gozlemde reltuples yukari sapmissa bytes_per_row asagi saparsa, o deger
-- taban olur ve sonraki her gozlem sismis gorunur.
--
-- Cozum: taban artik ham min degil, FARKLI GUNLERDEN gelen en dusuk uc
-- gunluk degerin medyani.
--
-- 3) GECERLILIK IKILIDIR, GUVEN KADEMELIDIR
-- ------------------------------------------
-- Kapi gecilemezse bulgu URETILMEZ. "Dusuk guvenle raporla" gecersizligin
-- cozumu degil; guven kademesi ancak GECERLI kanit uzerinde anlamlidir.
--
-- V1 kapisi (muhafazakar baslangic, backtest ile ayarlanacak):
--   ayni relation incarnation (relid)
--   AND ayni fillfactor rejimi
--   AND zaman uyumlu gecerli satir tahmini (ankraj koprusu)
--   AND kaynak = planli gece snapshot'i
--   AND >= 21 farkli gece
--   AND zaman yayilimi >= 28 gun

alter table fact.pg_relation_size_snapshot
  add column if not exists source text null;

comment on column fact.pg_relation_size_snapshot.source is
  'Bu gozlemin nereden geldigi. ''nightly'' = planli gece anlik goruntusu; YALNIZCA bunlar fiziksel sisme tabanina girer. ''watched'' = acik bloat alarmi olan tablolar icin gun ici olcum (30 dk); guncel durumu ve kaliciligi dogrular, taban havuzuna GIRMEZ — o gozlemler tablo zaten alarmli oldugu icin toplanir ve sistematik olarak sismis ani orneklerler. NULL = V110 oncesi satir, kaynagi bilinmiyor, tabana girmez (V110, PGSTAT-P0-046).';

-- Gecmis satirlar: V110 oncesi yazilanlarin kaynagi bilinmiyor. Gece
-- toplamasi olma ihtimali yuksek ama EMIN DEGILIZ; tahmin edip taban havuzuna
-- almak, olcmedigimiz bir seyi iddia etmek olur. NULL birakiliyor ve
-- dedektor onlari dislar.

create index if not exists ix_pg_relation_size_baseline_pool
  on fact.pg_relation_size_snapshot (instance_pk, relid, snapshot_ts)
  where source = 'nightly' and relid is not null
    and reltuples is not null and table_size_bytes is not null;
