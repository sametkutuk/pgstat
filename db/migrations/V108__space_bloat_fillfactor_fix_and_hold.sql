-- V108: fillfactor cift-dusme duzeltmesi + kurali gecici olarak durdurma
--
-- Dis inceleme (2026-08-31) V103/V104'te sevk edilen table_space_bloat
-- kuralinda uc dogruluk sorunu tespit etti. Biri koddan duzeltildi, ikisi
-- yeni veri toplama gerektiriyor.
--
-- 1) DUZELTILDI — fillfactor iki kez dusuluyordu
-- ---------------------------------------------
-- Taban (min_bytes_per_row) tablonun kendi gecmis gozlemlerinden geliyor;
-- o gozlemler ayni fillfactor rejiminde alindigi icin tasarim geregi bos
-- alani ZATEN iceriyor. Ustune (100/fillfactor) carpani uygulamak ayni payi
-- ikinci kez dusuyordu.
--
-- Etki: sisme EKSIK raporlaniyordu. fillfactor=70 bir tabloda gercek 3 kat
-- sisme 2.1 kat cikardi. Carpan kaldirildi.
--
-- 2) ACIK — boyut ile satir tahmini ayni ani temsil etmiyor
-- ---------------------------------------------------------
-- Pay, T anindaki table_size_bytes. Payda ise reltuples + T'den SONRAKI
-- delta'lar. Ama reltuples'in kendisi T'de degil, son VACUUM/ANALYZE'da
-- guncellenmisti — aylarca once olabilir. T oncesindeki bayatlik
-- duzeltilmiyor ve pay ile payda farkli zamanlara ait oluyor.
--
-- Cozum icin her boyut gozlemine ait as_of zamanli satir tahmini ve
-- kesintisiz delta kapsami gerekiyor; ankraj yoksa dedektor susmali.
--
-- 3) ACIK — "ayni tablonun gecmisi" garanti degil
-- -----------------------------------------------
-- fact.pg_relation_size_snapshot tablolari ADLA kimlikliyor; relid tasimiyor
-- (V039). Rename gecmisi boler; drop/recreate ya da adin yeniden kullanilmasi
-- FARKLI tablolari tek gecmis gibi birlestirir. Tarihsel minimum bu durumda
-- baska bir tablonun olcusu olur.
--
-- Bu ayrica V102/V103'teki "yeni veri toplama gerekmiyor" varsayimini
-- gecersiz kiliyor: snapshot'a en az relid eklenmeli ve yeterli gecmis
-- olusana kadar dedektor susmali.
--
-- KARAR: kural, 2 ve 3 giderilene kadar DEVRE DISI. Kural henuz tek bir alarm
-- uretmedi (iki gece anlik goruntusu bekliyordu), yani kapatmak mevcut bir
-- ciktiyi geri almiyor — yalnizca dogrulugu bilinmeyen bir ciktiyi hic
-- uretmemis oluyoruz. Ayrintili plan: PGSTAT-P0-046.

update control.alert_rule
   set is_enabled = false,
       description = description || E'\n\n' ||
         '[GEÇİCİ OLARAK DEVRE DIŞI — 2026-08-31] Dış inceleme iki açık ' ||
         'doğruluk sorunu tespit etti: (1) tablo boyutu ile satır sayısı ' ||
         'tahmini aynı ana ait değil, (2) tablo geçmişi adla eşleştiriliyor ' ||
         've yeniden adlandırma/silinip-yaratılma farklı tabloları ' ||
         'birleştirebiliyor. İkisi de yeni veri toplama gerektiriyor ' ||
         '(PGSTAT-P0-046). Kural, düzeltilene kadar kapalı; hiç alarm ' ||
         'üretmemişti, dolayısıyla mevcut bir çıktı geri alınmadı.'
 where evaluation_type = 'table_space_bloat'
   and is_enabled;
