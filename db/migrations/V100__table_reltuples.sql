-- V100: pg_class.reltuples toplanmaya baslaniyor
--
-- Bugune kadar bloat orani ve autovacuum tetikleme esigi
-- pg_stat_user_tables.n_live_tup uzerinden hesaplaniyordu. Ikisi de yanlisti:
--
--  1. Autovacuum'un KENDI esigi reltuples kullanir, n_live_tup degil:
--       anlthresh = autovacuum_analyze_threshold + analyze_scale_factor * reltuples
--       vacthresh = autovacuum_vacuum_threshold  + vacuum_scale_factor  * reltuples
--     Yani "esik asildi mi" sorusunu farkli bir tabanla cevapliyorduk.
--
--  2. n_live_tup istatistik sayaclarindan turetilir ve sunucu restart'inda
--     istatistikler kurtarilamazsa (crash, -m immediate, backup'tan restore)
--     sifirdan baslar. reltuples ise KATALOGDA durur, restart'i atlatir.
--
-- Uretimde olculen (2026-08-28, db1.dc-etstur.com-test / etstur):
-- sunucu 29 gun once restart olmus ve istatistikler kurtarilamamis
-- (stats_reset = postmaster_start_time + 3sn). t_ets_hotel_transaction_log
-- icin n_live_tup = 0 goruyorduk, katalog ise 30.404.328 satir diyordu
-- (5.3 GB tablo). Gercek olu oran %1.7, bizim hesapladigimiz %100 —
-- CRITICAL alert uretildi. Ayni instance'ta en az 15 tablo ayni durumdaydi.
-- Autovacuum ise dogru davraniyordu: gercek analyze esigi 1.520.266,
-- mevcut degisim 516.298, yani esigin %34'u.
--
-- NOT: PG14+'ta reltuples = -1 "hic vacuum/analyze edilmedi, bilinmiyor"
-- demektir; daha eski surumlerde 0 kullanilirdi. Her iki durumda da deger
-- kullanilmamalı, mevcut n_live_tup davranisina dusulmelidir.

alter table fact.pg_table_stat_delta
  add column if not exists reltuples bigint null;

comment on column fact.pg_table_stat_delta.reltuples is
  'pg_class.reltuples — katalogdaki satir sayisi tahmini. Autovacuum tetikleme esigi bunu kullanir ve istatistik sifirlamasindan etkilenmez, bu yuzden bloat orani ve esik hesabinda n_live_tup_estimate yerine tercih edilir. NEGATIF ya da NULL ise deger bilinmiyordur (PG14+ -1 sentinel) ve n_live_tup_estimate''e dusulur (V100, PGSTAT-P0-041).';
